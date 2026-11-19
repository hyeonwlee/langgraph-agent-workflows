## Workflow Implementation Notes
`langgraph-agent-workflows`에서 구현한 다섯 가지 워크플로우의 핵심 개념과 동작 과정을 정리한 문서입니다.

---

### 1. Basic Agent
가장 기본적인 형태의 LangGraph 에이전트입니다. 사용자 입력을 LLM에 전달하고 응답을 받아 종료합니다.

- **파일:** `01_basic_agent.ts`   
- **핵심 개념:** StateGraph, LLM 호출, Shared State   
- **사용 기술:** OpenAI GPT-4o-mini, MessagesZodState   
- **실행 흐름**: START → pm (GPT-4o-mini) → END
    - `MessagesZodState`가 제공하는 `messages` State를 사용합니다. `pmNode`에서 State에 저장된 메시지를 LLM에 전달하고, LLM의 응답을 반환하여 `messages`를 업데이트합니다.

---

### 2. Tool Calling Agent
LLM이 필요한 경우 외부 도구를 호출하고, 실행 결과를 다시 전달받아 답변을 생성하는 에이전트입니다.

- **파일:** `02_tool_calling.ts`
- **핵심 개념:** Tool Calling, ToolNode, Conditional Edge, Agent Loop
- **사용 기술:** OpenAI GPT-4o-mini, TavilySearch, LangGraph ToolNode, toolsCondition
- **실행 흐름**: START → agent → tools 또는 END
    - `bindTools`를 이용해 LLM에 사용 가능한 도구와 입력 형식을 전달합니다.
    - `agent`는 System Prompt와 사용자 질문을 바탕으로 답변하거나 Tool Call을 생성합니다.
    - `toolsCondition`은 Tool Call의 존재 여부에 따라 다음 Node를 결정합니다.
    - `ToolNode`가 해당 Tool Call을 실제로 실행합니다. TavilySearch를 실행하고, 검색 결과를 `ToolMessage`로 State에 추가합니다.
    - 다시 `agent`로 돌아갑니다. 검색 결과를 전달받은 LLM은 최종 답변을 생성하거나 추가 도구 호출을 요청합니다.

---

### 3. Human-in-the-Loop (HITL)
Tool Calling 구조에 사람의 승인 절차를 추가한 에이전트입니다. 도구를 실행하기 전에 Graph를 중단하고 사용자의 승인 여부에 따라 실행을 재개하거나 종료하도록 구현했습니다.

- **파일:** `03_human_in_the_loop.ts`
- **핵심 개념:** Human-in-the-Loop, interrupt, Checkpointing, Command, Graph Resume
- **사용 기술:** OpenAI GPT-4o-mini, TavilySearch, ToolNode, toolsCondition, MemorySaver
- **실행 흐름**:  
        START → agent → auth 또는 END   
        auth → 승인 시 tools → agent   
        auth → 거절 시 denied → END
    - State에는 `approved` 필드를 추가하여 도구 실행 승인 여부를 저장합니다.
    - `agentNode`는 사용자 질문을 LLM에 전달하고 필요한 경우 Tool Call을 생성합니다.
    - `toolsCondition`은 Tool Call 존재 여부에 따라 `auth` 또는 `END`로 이동시킵니다.
    - `authNode`는 도구 실행 승인을 받는 역할입니다. Tool Call이 있으면 `interrupt()`를 호출하여 실행을 중단하고 승인 요청 정보를 전달합니다. 이때 `MemorySaver`를 Checkpointer로 사용하여 중단된 Graph의 State를 저장합니다.
    - 사용자가 승인하면 `Command({ resume: { approved: true } })`를 전달하여 Graph를 재개하고 ToolNode에서 도구를 실행합니다. 이후 동일한 `thread_id`를 사용하여 중단된 Graph를 재개합니다.
    - 승인하지 않으면 `approved`가 `false`로 저장되고 `deniedNode`로 이동하여 도구를 실행하지 않고 종료합니다.

---

### 4. Plan-Execute Agent
사용자의 목표를 여러 단계의 실행 계획으로 나눈 뒤 각 단계를 순차적으로 실행하는 에이전트입니다. 실행 결과를 바탕으로 남은 계획을 다시 조정하는 Replanning 과정을 포함합니다.

- **파일:** `04_plan_execute.ts`
- **핵심 개념:** Planning, Plan-Execute, Replanning, Structured Output, Checkpointing
- **사용 기술:** OpenAI GPT-4o-mini, TavilySearch, LangGraph ToolNode, Conditional Edge, MemorySaver, Zod
- **실행 흐름**:
START → planner → execute →    
(도구 호출이 필요한 경우 tools →) replan →   
목표가 달성되지 않은 경우 execute   
목표가 달성된 경우 END
    - `MemorySaver`를 Checkpointer로 사용하여 Graph의 State를 저장합니다.
    - 주요 State는 다음으로, `plan`은 현재 남아 있는 실행 계획, `pastSteps`는 완료한 작업과 실행 결과, `response`는 최종 답변, `messages`는 LLM 대화 메시지를 의미합니다.
    - `planNode`는 사용자의 목표를 여러 단계로 분해합니다. Zod Schema를 활용한 Structured Output으로 실행 계획을 생성하고 State의 `plan`에 저장합니다.
    - `executeNode`는 세운 계획에 따라 현재 작업을 실행합니다.  
    현재 계획의 첫 번째 작업을 가져오고, 이전 작업 결과를 함께 참고합니다. 필요한 경우 TavilySearch를 호출할 수 있도록 LLM에 도구를 연결합니다. 실행할 계획이 없는 경우는 오류를 발생시켜 잘못된 실행을 방지합니다.
    - `shouldExecuteTool`은 Tool Call 여부를 판단합니다. Tool Call이 있으면 ToolNode에서 TavilySearch를 실행하고, 결과를 State에 추가한 뒤 Replanner로 이동합니다. 도구 호출이 없다면 바로 Replanner로 이동합니다.
    - `replanNode`는 지금까지의 실행 결과를 보고 목표 달성 여부를 판단합니다.   
    목표가 달성되었다면 최종 답변을 생성하여 `response`에 저장합니다. 아직 작업이 남았다면 남은 계획과 완료 작업을 업데이트합니다.
    - `shouldEnd`에서 최종 답변 생성 여부를 확인하고, 완료되지 않았다면 다시 Executor로 이동합니다.

---

### 5. RAG-based QA Workflow
사용자가 제공한 문서에서 질문과 관련된 내용을 검색하고, 검색 결과를 LLM에 Context로 전달하여 답변을 생성하는 워크플로우입니다. 질문의 의도를 분류하여 문서 검색이 필요한 질문과 일상적인 대화를 구분하고, 검색 결과가 답변에 충분한지 평가합니다.

- **파일:** `05_rag_workflow.ts`, `llamaCloud.ts`
- **핵심 개념:** RAG, Retrieval, Context, Query Classification
- **사용 기술:** LlamaCloud Retriever, OpenAI GPT-4o-mini, GPT-4o, LangGraph
- **실행 흐름**: START → retrieve → clarify → generate → END
    - 주요 State는 다음으로, `question`은 사용자 질문, `context`는 검색한 문서 내용, `answer`은 사용자에게 전달할 답변, `intent`는 질문 종류 (SEARCH 또는 CHAT)를 의미합니다.
    - `retrieveNode`는 질문 의도 분류와 문서 검색 두 가지 일을 수행합니다.   
    사용자의 질문을 보고 CHAT인지 SEARCH인지 LLM을 통해 분류합니다. `CHAT`이라면 문서 검색을 수행하지 않고 `context`를 비웁니다.   
    `SEARCH`라면 LlamaCloud Retriever로 관련 문서를 검색하고, 검색 결과를 하나의 문자열로 합쳐 `context`에 저장합니다.
    - `clarifyContext`는 검색 결과를 평가합니다.   
    검색 결과가 없는 경우 사용자에게 추가 정보를 요청하는 역질문을 생성합니다.   
    검색 결과가 있다면 LLM를 이용해 질문에 답변하기 충분한지 평가합니다. 충분하면 `PASS`를 반환하고, 부족하면 역질문을 생성하여 State의 `answer`에 저장합니다.
    - `generateNode`는 최종 답변을 생성합니다.   
    이미 `answer`가 존재한다면 추가 LLM 호출 없이 종료합니다.   
    그렇지 않으면 사용자 질문과 검색된 Context를 LLM에 전달하여 최종 답변을 생성합니다. `CHAT`인 경우 Context 없이 일반적인 대화를 생성하고, `SEARCH`인 경우 검색된 Context를 바탕으로 답변합니다.
    - 역질문을 생성한 뒤 Graph를 종료하며, 사용자의 추가 답변을 받아 자동으로 다시 검색하는 구조는 아닙니다.
    - 각 질문은 새로운 `graph.invoke()`로 실행되므로 이전 대화 기록을 유지하지 않습니다.

---

### 6. 추가 학습 아이디어
다음은 현재 구현된 워크플로우가 아니라, 이후 확장해 볼 학습 주제입니다.

### 6.1 개인 데이터와 웹 검색을 결합한 RAG
개인 문서 및 데이터 검색과 인터넷 검색을 하나의 에이전트에서 활용하는 방식입니다.

- **핵심 개념:** Vector Store, Embeddings, Retrieval
- **기술:** MemoryVectorStore, Google Embeddings, RetrieverTool, TavilySearch
- MemoryVectorStore에 문서의 Embedding을 저장하고 유사도 검색을 수행합니다
RetrieverTool을 통해 사용자 질문과 관련된 문서를 검색합니다.   
TavilySearch를 통해 외부 웹 검색을 수행합니다.   
개인 데이터 검색과 웹 검색 결과를 결합하는 하이브리드 검색 구조를 구현합니다.

### 6.2 대화 기억 에이전트
Checkpointer를 활용해 이전 대화 내용을 유지하는 에이전트입니다.

- **핵심 개념:** MemorySaver, Conversation History
- **기술:** MemorySaver, thread_id, readline interface
- MemorySaver를 통해 Graph의 State와 대화 기록을 저장합니다.  
`thread_id`를 기준으로 대화 세션을 구분합니다.   
`messages` State를 활용하여 이전 대화 내용을 LLM에 전달합니다.   
터미널 채팅 루프를 구현하고 System Prompt로 AI의 역할을 설정합니다.

### 6.3 커스텀 도구 에이전트
LangChain에서 제공하는 도구 외에 직접 정의한 도구를 사용하는 에이전트입니다.

- **핵심 개념:** Custom Tools, Zod Schema, StateSchema, Reducer
- **기술:** `@langchain/core/tools`, Zod
- `tool()` 함수와 Zod Schema를 이용해 사용자 정의 도구를 생성합니다.   
Zod Schema로 도구 입력값을 검증합니다.   
Reducer를 활용해 State의 기존 값과 새로운 값을 결합하거나 갱신합니다.   
직접 ToolNode를 구현하여 도구 실행 과정을 살펴봅니다.