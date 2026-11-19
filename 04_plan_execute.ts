import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, START, END, Annotation, MessagesAnnotation, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { TavilySearch } from "@langchain/tavily";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage, HumanMessage } from "@langchain/core/messages";


// 1. 도구 및 Checkpointer 정의
const tavilySearchTool = [new TavilySearch({ maxResults: 5 })];
const checkpointer = new MemorySaver();

// 2. Structured Output 스키마 정의
const Plan = z.object({
    steps: z.array(z.string().trim().min(1)).min(1)
        .describe("실행할 단계별 작업 목록"),
});

// Replanner의 출력은 남은 계획 또는 최종 답변이다.
const ReplanOutput = z.object({
    type: z.enum(["plan", "response"]),
    steps: z.array(z.string().trim().min(1)).nullable(),
    response: z.string().trim().nullable(),
});

// 3. Plan-Execute State 정의
const PlanExecuteState = Annotation.Root({
    ...MessagesAnnotation.spec,
    plan: Annotation<string[]>({
        reducer: (_current, update) => update ?? _current ?? [],
        default: () => [],
    }),
    pastSteps: Annotation<[string, string][]>({
        reducer: (current, update) => current.concat(update),
        default: () => [],
    }),
    response: Annotation<string>({
        reducer: (_current, update) => update ?? _current ?? "",
        default: () => "",
    }),
});

// 4. 모델 정의
const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
});

const executorLlm = llm.bindTools(tavilySearchTool);
const today = new Date().toISOString().split("T")[0];

// 5. Planner: 사용자의 목표를 실행 가능한 단계로 분해한다.
const plannerPrompt = `현재 날짜: ${today}

당신의 역할은 사용자의 목표를 달성하기 위한 단계별 실행 계획을 수립하는 것입니다.

지침:
1. 목표를 작고 구체적인 단계 3~5개로 나누세요.
2. 각 단계는 실행 결과를 확인할 수 있도록 구체적으로 작성하세요.
3. 최신 정보나 사실 확인이 필요한 경우 검색 단계를 포함하세요.
4. 단계를 논리적인 순서로 배열하세요.
5. 목표 달성에 꼭 필요한 단계만 포함하세요.

사용 가능한 도구: TavilySearch (웹 검색)`;

async function planNode(state: typeof PlanExecuteState.State) {
    const messages = [new SystemMessage(plannerPrompt), ...state.messages];
    const planner = llm.withStructuredOutput(Plan);
    const result = await planner.invoke(messages);

    return { plan: result.steps };
}

// 6. Executor: 현재 계획의 첫 번째 단계를 실행한다.
const executorPrompt = `현재 날짜: ${today}

당신의 역할은 전달받은 작업 단계를 실행하는 것입니다.

지침:
1. 최신 정보나 사실 확인이 필요한 경우 TavilySearch를 사용하세요.
2. 검색 결과를 바탕으로 답변하고, 근거가 부족하면 불확실성을 밝혀 주세요.
3. 검색이 필요하지 않은 작업은 직접 수행하세요.
4. 현재 단계의 실행 결과를 구체적으로 작성하세요.

사용 가능한 도구: TavilySearch (최대 5개 결과)`;

async function executeNode(state: typeof PlanExecuteState.State) {
    const task = state.plan[0];

    // 실행할 단계가 없는 경우를 감지한다.
    if (!task) {
        throw new Error("실행할 계획이 없습니다. Planner의 출력을 확인해 주세요.");
    }

    const previousResults = state.pastSteps
        .map(([step, result]) => `- ${step}: ${result}`)
        .join("\n");

    const input = `실행할 작업: ${task}

이전 완료된 작업들:
${previousResults || "아직 완료된 작업이 없습니다."}`;

    const response = await executorLlm.invoke([
        new SystemMessage(executorPrompt),
        new HumanMessage(input),
    ]);

    return { messages: [response] };
}

// 7. Tool 실행 Node
const toolsNode = new ToolNode(tavilySearchTool);

// 8. Replanner: 실행 결과를 검토해 남은 계획 또는 최종 답변을 반환한다.
const replannerPrompt = `현재 날짜: ${today}

당신의 역할은 원래 계획과 실행 결과를 검토하여 다음 단계를 결정하는 것입니다.

다음 두 가지 중 하나를 선택하세요.

1. 목표가 아직 달성되지 않았다면:
   - type: "plan"
   - steps: 남은 실행 단계 목록
   - response: null
   - 이미 완료된 현재 단계는 남은 단계에서 제외하세요.

2. 목표가 달성되었다면:
   - type: "response"
   - steps: null
   - response: 실행 결과를 종합한 사용자용 최종 답변

실행 결과를 근거로 판단하고, 아직 확인하지 않은 내용을 완료했다고 말하지 마세요.`;

function messageContentToText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    return JSON.stringify(content, null, 2) ?? String(content);
}

async function replanNode(state: typeof PlanExecuteState.State) {
    const completedTask = state.plan[0];
    const lastMessage = state.messages[state.messages.length - 1];

    if (!completedTask || !lastMessage) {
        throw new Error("Replanner에 전달할 작업 또는 실행 결과가 없습니다.");
    }

    const executionResult = messageContentToText(lastMessage.content);
    const previousResults = state.pastSteps
        .map(([step, result]) => `- ${step}: ${result}`)
        .join("\n");

    const replanner = llm.withStructuredOutput(ReplanOutput);
    const output = await replanner.invoke([
        new SystemMessage(replannerPrompt),
        new HumanMessage(`원래 계획: ${JSON.stringify(state.plan)}
        이전 완료된 작업들: ${previousResults || "없음"}
        방금 실행한 작업: ${completedTask}
        실행 결과: ${executionResult}
        위 정보를 바탕으로 목표 달성 여부를 판단하고 다음 단계를 결정하세요.`),
    ]);

    // 완료한 작업과 결과를 기록한다.
    const completedStep: [string, string][] = [[completedTask, executionResult]];

    if (output.type === "response") {
        return {
            plan: [],
            response: output.response,
            pastSteps: completedStep,
        };
    }

    return {
        plan: output.steps,
        pastSteps: completedStep,
    };
}

// 9. Conditional Edge 함수
function shouldExecuteTool(state: typeof PlanExecuteState.State) {
    const lastMessage = state.messages[state.messages.length - 1];

    if (lastMessage instanceof AIMessage && lastMessage.tool_calls.length > 0) {
        return "tools";
    }
    return "replan";
}

function shouldEnd(state: typeof PlanExecuteState.State) {
    return state.response ? END : "execute";
}

// 10. Graph 구성
const planExecuteWorkflow = new StateGraph(PlanExecuteState)
    .addNode("planner", planNode)
    .addNode("execute", executeNode)
    .addNode("tools", toolsNode)
    .addNode("replan", replanNode)
    .addEdge(START, "planner")
    .addEdge("planner", "execute")
    .addConditionalEdges("execute", shouldExecuteTool, {
        tools: "tools",
        replan: "replan",
    })
    .addEdge("tools", "replan")
    .addConditionalEdges("replan", shouldEnd, {
        execute: "execute",
        [END]: END,
    });

export const planExecuteGraph = planExecuteWorkflow.compile({ checkpointer });
