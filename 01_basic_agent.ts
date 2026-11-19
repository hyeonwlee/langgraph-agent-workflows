import "dotenv/config";
import { END, MessagesZodState, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";


// 1. 모델 정의
const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0.3,
    apiKey: process.env.OPENAI_API_KEY,
});

// 2. 모델 호출 Node
async function pmNode(state: z.infer<typeof MessagesZodState>) {
    const response = await llm.invoke(state.messages);
    return { messages: [response] };
};

// 3. Graph 구성
const workflow = new StateGraph(MessagesZodState)
    .addNode("pm", pmNode)
    .addEdge(START, "pm")
    .addEdge("pm", END);

export const graph = workflow.compile();