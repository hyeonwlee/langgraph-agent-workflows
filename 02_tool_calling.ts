import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { StateGraph, START, END, MessagesZodState } from "@langchain/langgraph";
import { z } from "zod";
import { TavilySearch } from "@langchain/tavily";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage } from "@langchain/core/messages";


// 1. 도구와 모델 정의
const tavilySearchTool = [new TavilySearch({ maxResults: 5 })];

const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY
}).bindTools(tavilySearchTool);

const today = new Date().toISOString().split('T')[0];

// 모델의 검색 및 응답 기준이다.
const systemPrompt = new SystemMessage(`
[IMPORTANT 지시사항]
1. 최신 정보나 사실 확인이 필요한 경우 웹 검색을 활용하세요.
2. 검색 결과를 바탕으로 답변하세요.
3. 검색 결과가 충분하지 않다면 정보가 부족하다고 명시하세요.
4. 검색이 필요하지 않은 질문에는 바로 답변하세요.

현재 날짜: ${today}
도구: TavilySearch (최대 5개 결과)
`);

// 2. Node 정의
async function pmNode(state: z.infer<typeof MessagesZodState>) {
    const messagesWithSystem = [systemPrompt, ...state.messages];
    const response = await llm.invoke(messagesWithSystem);

    return { messages: [response] };
}

// LLM이 요청한 도구 호출을 실제로 실행한다.
const toolsNode = new ToolNode(tavilySearchTool);

async function shouldContinue(state: z.infer<typeof MessagesZodState>) {
    return toolsCondition(state);
}

// 3. Graph 구성
const workflow = new StateGraph(MessagesZodState)
    .addNode("agent", pmNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, {
        tools: "tools",
        __end__: END,
    })
    .addEdge("tools", "agent");

// 4. Graph 컴파일
export const graph = workflow.compile();