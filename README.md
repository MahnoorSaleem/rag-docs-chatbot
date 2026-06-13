# doc-chatbot

A RAG (Retrieval-Augmented Generation) chatbot that answers questions about your own documentation: no fine-tuning, no paid embeddings API, no managed vector database required.

## Why I built this

LLMs are great at language but blind to your private docs. The naive fix, paste the whole document into the prompt, falls apart quickly: token limits, cost, and the model getting distracted by irrelevant sections all hurt answer quality.

RAG is the better fix: embed your docs into a vector store at ingest time, then at query time retrieve only the relevant chunks and hand those to the model along with the question. The model doesn't need to "know" the docs, it just has to synthesize an answer from what retrieval gives it.

This is a fairly minimal implementation of that pattern, using local embeddings and a self-hosted vector store so the only external dependency is the inference API (and the reranker).

## How it works

```
docs/          →  ingest.ts  →  ChromaDB (vectors)
                                    ↓
user question  →   rag.ts   →  top-20 candidates  →  Jina rerank  →  top-5  →  Groq LLM  →  answer + sources
                                    ↑
                             server.ts (POST /chat)
```

1. **Ingest**: reads every file in `docs/`, splits it into 256-token chunks with 50-token overlap, embeds each chunk with a local HuggingFace model, and stores the vectors in ChromaDB.
2. **Retrieve**: on each question, cosine-similarity search returns the top-20 candidate chunks, which a Jina AI reranker re-scores against the question and narrows to the top 5.
3. **Generate**: the chunks are passed to Groq's LLaMA 3.1 8B with a strict system prompt: answer only from context, cite the source file.
4. **Serve**: an Express server exposes `POST /chat` wrapping steps 2–3, plus `POST /feedback` for rating answers.

Every stage logs its own latency/counts, and there's a separate offline script for checking retrieval quality with an LLM judge (see [Evaluation](#evaluation) below).

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + TypeScript (`tsx` for dev) |
| RAG framework | LlamaIndex |
| Embeddings | HuggingFace `all-MiniLM-L6-v2` via ONNX (local) |
| Reranker | Jina AI Reranker (`jina-reranker-v1-base-en`) |
| Vector store | ChromaDB (self-hosted) |
| LLM | Groq API, `llama-3.1-8b-instant` |
| HTTP server | Express 5 |
| Logging | pino + pino-http (structured, pretty-printed in dev) |

## Architecture decisions

A few notes on the choices that weren't obvious, in case future-me (or you) wonders why something is the way it is.

**Local embeddings, not an API.** `all-MiniLM-L6-v2` runs locally via ONNX through LlamaIndex's HuggingFace integration. That means ingestion can be re-run as many times as needed without per-call cost, and document text never leaves the machine. 384 dimensions is small enough to be fast. The only annoying part is a cold-start delay the first time ONNX loads the model weights; every call after that is quick.

**Rerank the candidate set.** Cosine similarity is a coarse signal: it ranks by vector-space proximity, which doesn't always match what's actually relevant to the question. So retrieval pulls a wider net (top-20) and a Jina reranker, which scores each chunk directly against the question text, narrows that down to the top 5. Costs one extra API call per query but the top-5 is noticeably better than similarity search alone.

**ChromaDB over Pinecone/Weaviate.** Mostly a "keep it simple" call: one Docker command, no account, data stays on disk, and LlamaIndex has a first-class integration. An in-memory FAISS index would lose everything on restart, and a cloud vector DB adds external state I didn't want for a dev project.

**Groq for inference.** Fast, generous free tier, and honestly for this use case a small-but-fast model beats a large-but-slow one, since retrieval has already narrowed things down to a short context, so the model's job is synthesis, not deep reasoning.

**`CompactAndRefine` as the response synthesizer.** LlamaIndex has a few ways to turn multiple chunks into one answer. `Refine` calls the LLM once per chunk, which is slow and wasteful for short answers. `CompactAndRefine` packs everything into a single call when it fits and only falls back to multi-step refinement if the context is too big. Keeps latency down for the typical case.

**Chunk size 256, overlap 50.** Smaller chunks = better retrieval precision, since each chunk is roughly one concept instead of a whole section. The 50-token overlap is there so an answer that straddles a chunk boundary doesn't get cut in half.

**Index caching in the server.** `VectorStoreIndex.fromVectorStore()` hits ChromaDB for metadata every time it's called. Doing that per-request adds latency for no reason, so there's a module-level `cachedIndex ??= await ...` that pays the setup cost once and reuses the index after that.

**Structured logging, system + component level.** A single "got a question, sent an answer" log line tells you *that* something happened but not *where* the time went. So there are two layers: `pino-http` logs one line per HTTP request (status, latency, request id), the system view, and a `logger.child({ component: "rag" })` inside the pipeline logs each stage (retrieve, rerank, generate) with its own count and duration, the component view. `ingest.ts` does the same for its stages.

## Evaluation

Logging tells you a request was slow or errored, but not whether the *answer* was actually good. For that I'm using a small evaluation framework with two axes: **scope** (component vs. system) and **evaluator type** (code-based, LLM-as-judge, human feedback).

| | Code-based | LLM-as-judge | Human feedback |
|---|---|---|---|
| **Component** (retrieval) | retrieve/rerank latency, logged in `rag.ts` | context quality via `npm run eval` | not implemented (too high-friction) |
| **System** (whole request) | token usage, logged in `rag.ts` | citation accuracy, not yet, planned as an `eval.ts` extension | thumbs up/down via `POST /feedback` |

### Context quality (`npm run eval`)

An offline script (`src/eval.ts`) that runs a fixed set of test questions through the real retrieve→rerank pipeline, then asks the LLM to score 1–5 whether the retrieved context actually contains enough to answer the question:

```bash
npm run eval
```

This runs against the live ChromaDB index, so re-run it after re-ingesting or changing the chunking/reranking config to catch retrieval regressions. It's deliberately offline rather than live, since judging every `/chat` request would double the LLM calls (and the latency) on the hot path.

### Token usage

Every `generated answer` log line from `rag.ts` includes the token usage Groq returns (`prompt_tokens`, `completion_tokens`, `total_tokens`, plus Groq's timing breakdown), summed across any internal refine calls. This was previously discarded, and it's useful for cost tracking without any extra calls.

### Thumbs up / down feedback

`/chat` returns a `requestId` (the pino-http request id). The client can later call `/feedback` with that id and a rating, and it gets logged correlated to the original request (see [API](#api) below).

## Challenges

**ESM + TypeScript with LlamaIndex.** LlamaIndex is ESM-first, which means `"type": "module"` in `package.json`, `moduleResolution: "nodenext"` in `tsconfig.json`, and `.js` extensions on every internal import, even though the source files are `.ts`. TypeScript's ESM rules say the compiler rewrites `.ts → .js`, but the import path in source has to already say `.js`. Took a few `require is not defined` / `ERR_MODULE_NOT_FOUND` errors before that clicked.

**Shared setup without duplication.** Both ingest and query need the same embed model config and ChromaDB connection. I factored that into `src/config.ts`, which runs `dotenv.config()` and sets `Settings.embedModel` as module-level side effects. Because ES module imports are resolved before the importing file's body runs, `config.ts` always executes first, so `process.env.*` is populated by the time anything else needs it.

**`PromptTemplate` and literal braces.** While writing the LLM-judge prompt for `eval.ts`, I used LlamaIndex's `PromptTemplate` and asked the model to respond with a JSON object like `{"score": ..., "reasoning": ...}`. Turns out `PromptTemplate.format()` treats *any* `{...}` in the template as a placeholder to fill, including that literal JSON example, and throws "Replacement index out of range". Switched to a plain template literal for that prompt; `PromptTemplate` is really meant for templates whose only braces are actual variables.

## Prerequisites

- Node.js 18+
- A running ChromaDB instance (default `http://localhost:8000`)
- A [Groq API key](https://console.groq.com)
- A [Jina AI API key](https://jina.ai/reranker) (free tier available, used for reranking)

**Start ChromaDB with Docker:**

```bash
docker run -p 8000:8000 chromadb/chroma
```

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
GROQ_API_KEY="your-groq-api-key"
JINAAI_API_KEY="your-jina-api-key"
CHROMA_URL="http://localhost:8000"
PORT="3000"
LOG_LEVEL="info"
```

`LOG_LEVEL` controls pino's verbosity (`info` by default). Set to `debug` to also see per-document detail during ingest.

## Usage

### 1. Add your docs

Place `.md` or plain-text files in `docs/`. The existing files are sample docs, replace or extend them.

### 2. Ingest

```bash
npm run ingest
```

Embeds all files in `docs/` and loads them into ChromaDB. Re-run whenever you add or update documents.

### 3. Start the server

```bash
npm start
```

### 4. Ask a question

```bash
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "What are the installation steps?"}' | jq
```

```json
{
  "answer": "To install the package, run `npm install mypackage`...",
  "sources": ["getting-started.md"],
  "requestId": 1
}
```

### 5. (Optional) Send feedback on an answer

```bash
curl -s -X POST http://localhost:3000/feedback \
  -H "Content-Type: application/json" \
  -d '{"requestId": 1, "rating": "up"}'
```

### Run the RAG pipeline directly (no server)

```bash
npm run rag
```

Runs a set of hardcoded test questions against ChromaDB and prints answers to stdout. Useful for smoke-testing after a re-ingest. Also prints a before/after comparison of the candidate ranking pre- and post-rerank via `inspect()`.

### Run the retrieval-quality eval

```bash
npm run eval
```

See [Evaluation](#evaluation) above.

## Logging & Observability

Logging uses [pino](https://getpino.io), pretty-printed in dev via `pino-pretty`, at two levels:

- **System level**: `pino-http` middleware in `server.ts` logs one line per HTTP request/response (method, URL, status code, response time, request id).
- **Component level**: `rag.ts`, `ingest.ts`, and `server.ts` each get a child logger via `logger.child({ component: "..." })`. Inside `ask()`, every pipeline stage (retrieve, rerank, generate) logs its own candidate count, duration, and, for `generate`, token usage, so a slow or failing request can be traced to a specific stage.

Example output for a single `/chat` request:

```
[INFO] retrieved candidates   component=rag   stage=retrieve count=20 ms=45
[INFO] reranked candidates    component=rag   stage=rerank   count=5  ms=320
[INFO] generated answer       component=rag   stage=generate ms=890  usage={"prompt_tokens":593,"completion_tokens":58,"total_tokens":651,...}
[INFO] answered question      component=chat  question="..." sources=[...] ms=1255
[INFO] request completed      req={...} res={"statusCode":200} responseTime=1257
```

`ingest.ts` logs the same way per stage (`clear`, `load`, `index`).

## Project structure

```
doc-chatbot/
├── docs/               # Source documents to index
├── src/
│   ├── config.ts       # Shared: dotenv, embed model, ChromaDB connection
│   ├── logger.ts       # Shared pino logger instance
│   ├── ingest.ts       # Load docs → chunk → embed → store in ChromaDB
│   ├── rag.ts          # Retrieve → rerank → generate; exports ask(), inspect(), retrieveAndRerank()
│   ├── eval.ts          # Offline LLM-as-judge eval for context quality (npm run eval)
│   └── server.ts       # Express server with POST /chat and POST /feedback
├── .env
├── package.json
└── tsconfig.json
```

## API

### `POST /chat`

**Body:** `{ "question": "string" }`

**Response:**

```json
{
  "answer": "string",
  "sources": ["filename.md"],
  "requestId": 1
}
```

| Status | Meaning |
|---|---|
| `400` | `question` missing or empty |
| `500` | Internal error, check server logs |

### `POST /feedback`

**Body:** `{ "requestId": 1, "rating": "up" | "down" }`

Logs the rating correlated to the original `/chat` request (by `requestId`). Returns `204` with no body on success.

| Status | Meaning |
|---|---|
| `204` | Feedback recorded |
| `400` | `requestId` missing or `rating` is not `"up"`/`"down"` |
