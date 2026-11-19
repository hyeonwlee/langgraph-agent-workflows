import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { END, START, Annotation, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { retriever } from "./llamaCloud";

// 1. Graph State 정의
const AgentState = Annotation.Root({
  question: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  context: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  answer: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // 질문 분류 결과를 저장한다.
  intent: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "CHAT",
  }),
});

// 2. 분류 모델 정의
const classifierModel = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
});

// 3. 검색 및 분류 Node
const retrieveNode = async (state: typeof AgentState.State) => {
  if (!state.question || state.question.trim() === "") {
    return {
      context: "",
      answer: "안녕하세요! 무엇을 도와드릴까요?",
    };
  }
  const classifierPrompt = `
    당신은 질문을 분석하여 '검색(Search)'이 필요한지 '일상 대화(Chat)'인지 판단하는 분류기입니다.
    
    - 사용자의 질문이 사실 확인, 정보 검색, 지식 요청이라면 "SEARCH"라고 답하세요.
    - 사용자의 질문이 인사("안녕"), 감사("고마워"), 단순 잡담이라면 "CHAT"이라고 답하세요.
    
    질문: ${state.question}
    답변(SEARCH 또는 CHAT):
  `;

  const classification = await classifierModel.invoke(classifierPrompt);
  const intent = classification.content.toString().trim().toUpperCase();

  console.log(`🤖 질문 의도 파악: ${intent}`);

  if (intent === "CHAT") {
    return { context: "", intent: intent };
  }
  console.log(`🔍 LlamaCloud 검색 시작: ${state.question}`);
  const retrievedNodes = await retriever.retrieve(state.question);

  const context = retrievedNodes
    .map((node) => node.node?.text || "")
    .join("\n\n---\n\n");

  console.log(`✅ 검색 완료! (문서 길이: ${context.length})`);
  
  return { context: context, intent: intent };
};

// 4. 답변 생성 Node
const generateNode = async (state: typeof AgentState.State) => {
  if (state.answer) {
    return {};
  }

  const llm = new ChatOpenAI({
    model: "gpt-4o",
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
  });

  const prompt = ChatPromptTemplate.fromTemplate(`
    당신은 친절한 AI 어시스턴트입니다.

    다음 규칙에 따라 답변하세요:
    1. [Context] 내용이 있다면: 철저히 [Context]를 바탕으로 답변하세요. 문서에 없는 내용은 "문서에 해당 내용이 없습니다"라고 하세요.
    2. [Context] 내용이 없다면(빈 경우): 사용자의 질문이 일상적인 인사나 잡담이라면 자연스럽게 대화하세요. (예: "안녕하세요!", "반갑습니다.")

    [Context]:
    {context}

    [Question]:
    {question}
  `);

  const chain = prompt.pipe(llm);

  const response = await chain.invoke({
    context: state.context,
    question: state.question,
  });

  return { answer: response.content as string };
};

// 5. 검색 결과 평가 Node
const evaluateContextNode = async (state: typeof AgentState.State) => {
  if (state.answer || state.intent === "CHAT") {
    return {};
  }
  if (!state.context || state.context.trim() === "") {

    const llm = new ChatOpenAI({
      model: "gpt-4o-mini",
      temperature: 0.7,
      apiKey: process.env.OPENAI_API_KEY,
    });

    const clarificationPrompt = `
      사용자가 정보를 요청했으나 관련된 문서를 찾을 수 없습니다.
      사용자의 질문: "${state.question}"
      
      사용자에게 정보를 더 구체적으로 알려달라고 정중하게 요청하는 역질문을 하나만 작성하세요.
      예시: "말씀하신 내용에 대한 정보가 부족합니다. 혹시 ~에 대한 내용을 찾으시나요?"
    `;

    const response = await llm.invoke(clarificationPrompt);

    return { answer: response.content as string };
  }

  const evaluator = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY,
  });

  const evalPrompt = `
    당신은 검색된 문서가 사용자의 질문에 답변하기 충분한지 평가하는 판단자입니다.

    [질문]: ${state.question}
    [검색된 문서]: ${state.context.substring(0, 2000)}... (생략)

    규칙:
    1. 문서의 내용으로 질문에 답변할 수 있다면 "PASS"라고만 출력하세요.
    2. 문서의 내용이 질문과 관련이 없거나, 정보가 부족하여 답변하기 어렵다면
       사용자에게 추가 정보를 묻는 "역질문"을 한 문장으로 작성하세요.
       (예: "검색 결과에 A에 대한 내용은 있지만 B는 없습니다. A에 대해 설명해 드릴까요?")
  `;

  const evalResponse = await evaluator.invoke(evalPrompt);
  const result = evalResponse.content.toString().trim();

  console.log(`🤔 Clarify 판단 결과: ${result}`);

  if (result === "PASS") {
    return {};
  } else {
    return { answer: result };
  }
};

// 6. Graph 구성
const workflow = new StateGraph(AgentState)
  .addNode("retrieve", retrieveNode)
  .addNode("clarify", evaluateContextNode)
  .addNode("generate", generateNode)
  .addEdge(START, "retrieve")
  .addEdge("retrieve", "clarify")
  .addEdge("clarify", "generate")
  .addEdge("generate", END);

export const graph = workflow.compile();