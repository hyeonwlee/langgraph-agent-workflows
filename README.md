# LangGraph Agent Workflows


## 1. 소개

LangGraph.js와 TypeScript를 활용하여 기본적인 LLM 호출부터 도구 사용, Human-in-the-Loop, Plan-Execute, RAG 기반 질의응답까지 단계별로 구현한 학습 프로젝트입니다.


## 2. 사용 기술

- 언어: TypeScript
- 프레임워크: LangGraph.js
- LLM: OpenAI GPT-4o-mini, GPT-4o
- 도구: TavilySearch, LlamaCloud Retriever
- 스키마 검증: Zod
- 개발 환경: Node.js, LangGraph CLI


## 3. 주요 내용

기본 에이전트부터 다양한 도구 및 상태 관리 기능을 활용한 워크플로우까지 구현했습니다.
- 기본 에이전트 및 LLM 호출
- TavilySearch를 활용한 도구 사용 에이전트
- interrupt와 Checkpointing을 활용한 Human-in-the-Loop
- Structured Output 기반 Plan-Execute 에이전트
- LlamaCloud Retriever를 활용한 RAG 기반 질의응답

각 워크플로우의 상세 구현 과정과 학습 내용은 [WORKFLOWS.md](./WORKFLOWS.md)에 정리했습니다.


## 4. 실행 방법

프로젝트 루트에서 의존성을 설치하고 환경 변수 파일을 준비합니다.

```bash
npm install
```

```powershell
Copy-Item .env.example .env
```
`.env`에 필요한 API Key를 설정한 뒤 개발 서버를 실행합니다.

```bash
npm run dev:server
```

LangGraph Studio에서 실행할 워크플로우를 선택할 수 있습니다.