import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, START, END, Annotation, interrupt, MemorySaver, MessagesAnnotation, Command } from "@langchain/langgraph";
import { TavilySearch } from "@langchain/tavily";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, AIMessage } from "@langchain/core/messages";


// 1. 도구와 모델 정의
const tavilySearchTool = [new TavilySearch({ maxResults: 5 })];

const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
}).bindTools(tavilySearchTool);

const today = new Date().toISOString().split("T")[0];

const systemPrompt = new SystemMessage(`
당신은 웹 검색 도구를 사용할 수 있는 AI 어시스턴트입니다.

1. 최신 정보나 사실 확인이 필요한 경우 TavilySearch를 사용하세요.
2. 검색 결과를 바탕으로 답변하고, 근거가 부족하면 불확실성을 밝혀 주세요.
3. 검색이 필요하지 않은 질문에는 바로 답변하세요.

현재 날짜: ${today}
사용 가능한 도구: TavilySearch (최대 5개 결과)
`);

// 2. Graph State 정의
// messages 외에 도구 승인 여부를 저장할 approved 필드를 추가한다.
const AgentState = Annotation.Root({
    ...MessagesAnnotation.spec,
    approved: Annotation<boolean | null>({
        reducer: (_current, update) => update ?? _current,
        default: () => null,
    }),
});

// 3. Node 정의
async function agentNode(state: typeof AgentState.State) {
    const response = await llm.invoke([systemPrompt, ...state.messages]);
    return { messages: [response] };
}

const toolsNode = new ToolNode(tavilySearchTool);

// Tool Call이 있으면 승인 단계로, 없으면 Graph를 종료한다.
function shouldContinue(state: typeof AgentState.State) {
    return toolsCondition(state);
}

// 승인 요청을 호출한 쪽에 전달하고 Graph 실행을 멈춘다.
async function authNode(state: typeof AgentState.State) {
    const lastMessage = state.messages[state.messages.length - 1];

    if (!(lastMessage instanceof AIMessage) || !lastMessage.tool_calls?.length) {
        throw new Error("승인할 Tool Call을 찾을 수 없습니다.");
    }

    const decision: unknown = interrupt({
        type: "tool_approval",
        message: "다음 도구 호출을 실행할까요?",
        toolCalls: lastMessage.tool_calls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
        })),
    });

    const approved =
        typeof decision === "object" &&
        decision !== null &&
        "approved" in decision &&
        decision.approved === true;

    return { approved };
}

// 승인 여부에 따라 도구 실행 또는 거부 처리로 분기한다.
function routeAfterApproval(state: typeof AgentState.State) {
    return state.approved ? "tools" : "denied";
}

async function deniedNode() {
    return {
        messages: [
            new AIMessage("도구 실행이 승인되지 않아 검색을 진행하지 않았습니다."),
        ],
    };
}

// 4. Graph 구성 및 Checkpointer 연결
const checkpointer = new MemorySaver();

const workflow = new StateGraph(AgentState)
    .addNode("agent", agentNode)
    .addNode("auth", authNode)
    .addNode("tools", toolsNode)
    .addNode("denied", deniedNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, {
        tools: "auth",
        __end__: END,
    })
    .addConditionalEdges("auth", routeAfterApproval, {
        tools: "tools",
        denied: "denied",
    })
    .addEdge("tools", "agent")
    .addEdge("denied", END);

export const graph = workflow.compile({ checkpointer });