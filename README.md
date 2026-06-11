# doc-chatbot

A RAG (Retrieval-Augmented Generation) chatbot that answers questions about your own documentation — no fine-tuning, no paid embeddings API, no managed vector database required.

## Why I built this

LLMs are great at language but blind to your private docs. The naive fix — pasting the whole document into the prompt — breaks down quickly: token limits, cost, and the model attending to irrelevant sections all degrade answer quality.

RAG solves this properly: embed your docs into a vector store at ingest time, then at query time retrieve only the relevant chunks and hand them to the model with the question. The model never needs to "know" the docs; it just synthesizes from what retrieval hands it.

This project is a focused implementation of that pattern using fully local embeddings and a self-hosted vector store, so the only external dependency is the inference API.

## How it works

```
docs/          →  ingest.ts  →  ChromaDB (vectors)
                                    ↓
user question  →   rag.ts   →  top-20 candidates  →  Jina rerank  →  top-5  →  Groq LLM  →  answer + sources
                                    ↑
                             server.ts (POST /chat)
```

1. **Ingest** — reads every file in `docs/`, splits it into 256-token chunks with 50-token overlap, embeds each chunk with a local HuggingFace model, and stores the vectors in ChromaDB.
2. **Retrieve** — on each question, cosine-similarity search returns the top-20 candidate chunks, which a Jina AI reranker re-scores against the question and narrows to the top 5.
3. **Generate** — the chunks are passed to Groq's LLaMA 3.1 8B with a strict system prompt: answer only from context, cite the source file.
4. **Serve** — an Express server exposes `POST /chat` wrapping steps 2–3.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + TypeScript (`tsx` for dev) |
| RAG framework | LlamaIndex |
| Embeddings | HuggingFace `all-MiniLM-L6-v2` via ONNX (local) |
| Reranker | Jina AI Reranker (`jina-reranker-v1-base-en`) |
| Vector store | ChromaDB (self-hosted) |
| LLM | Groq API — `llama-3.1-8b-instant` |
| HTTP server | Express 5 |
| Logging | pino + pino-http (structured, pretty-printed in dev) |

## Architecture decisions

**Local embeddings over an API**
`all-MiniLM-L6-v2` runs locally via ONNX through LlamaIndex's HuggingFace integration. Ingestion can re-embed freely without per-call cost, and no document text leaves the machine. At 384 dimensions it's compact and fast. The tradeoff is a cold-start delay the first time the ONNX runtime loads the model weights — subsequent calls are fast.

**Reranking the candidate set**
Cosine similarity over embeddings is a coarse relevance signal — it ranks by vector-space proximity, which doesn't always line up with what's actually relevant to the question. Retrieving a wider candidate set (top-20) and passing it through a Jina AI reranker, which scores each chunk directly against the question text, produces a noticeably more relevant top-5 than similarity search alone — at the cost of one extra API call per query.

**ChromaDB over Pinecone / Weaviate**
Self-hosted with one Docker command, no account, data stays local. LlamaIndex has a first-class integration. The alternative of an in-memory FAISS index would lose all vectors on restart; Pinecone or Qdrant cloud would add external state. ChromaDB hits the right point on that tradeoff for a dev project.

**Groq for inference**
Fast inference on LLaMA 3.1 8B with a generous free tier. For Q&A over retrieved context, a small-but-fast model beats a large-but-slow one — the retrieval step has already narrowed the problem to a short context window. The model's job is synthesis, not world knowledge.

**`CompactAndRefine` response synthesizer**
LlamaIndex offers several ways to combine multiple retrieved chunks into one answer. `Refine` calls the LLM once per chunk (slow, expensive for short answers). `CompactAndRefine` packs all chunks into a single LLM call when they fit, and only falls back to multi-step refinement when the combined context is too long. That keeps latency and cost low for typical queries.

**Chunk size 256 / overlap 50**
Smaller chunks improve retrieval precision — each chunk covers one concept rather than a whole section, so a top-5 retrieval is more focused. The 50-token overlap prevents an answer from being split across a chunk boundary and lost. 256 tokens is large enough to include enough context around a fact, small enough to stay precise.

**Index caching in the server**
`VectorStoreIndex.fromVectorStore()` fetches index metadata from ChromaDB on every call. Running it on each incoming request adds round-trip latency and unnecessary load. A module-level cache (`cachedIndex ??= await ...`) pays the initialization cost once on the first request and reuses the index for everything after.

**Structured logging: system level vs component level**
A single log line per request ("got a question", "sent an answer") tells you *that* something happened but not *where* the time went or what failed inside. Two layers cover both: `pino-http` middleware logs one line per HTTP request/response (method, status, latency, request id) — the system-level view. Inside the pipeline, a `logger.child({ component: "rag" })` instance logs each stage (retrieve, rerank, generate) separately with its own count and duration — the component-level view needed to see *why* a request was slow or *where* it failed. `ingest.ts` follows the same pattern for its own stages (clear, load, index).

## Challenges

**ESM + TypeScript with LlamaIndex**
LlamaIndex is ESM-first, which means `"type": "module"` in `package.json`, `moduleResolution: "nodenext"` in `tsconfig.json`, and `.js` extensions in all internal imports — even though the source files are `.ts`. TypeScript's ESM rules require that: the compiler rewrites `.ts → .js` but the import path in source must already say `.js`. Getting this right took a few `require is not defined` and `ERR_MODULE_NOT_FOUND` errors to shake out.

**Shared setup without duplication**
Both the ingest and query pipelines need the same embed model configuration and ChromaDB connection. The naive approach copies the setup into each file. I factored it into `src/config.ts`, which calls `dotenv.config()` and configures `Settings.embedModel` as module-level side effects. Because ES module imports are resolved before the importing file's body runs, config.ts executes first — so `process.env.*` is populated by the time any other module needs it.

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

Place `.md` or plain-text files in `docs/`. The existing files are sample docs — replace or extend them.

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
  "sources": ["getting-started.md"]
}
```

### Run the RAG pipeline directly (no server)

```bash
npm run rag
```

Runs a set of hardcoded test questions against ChromaDB and prints answers to stdout. Useful for smoke-testing after a re-ingest. Also prints a before/after comparison of the candidate ranking pre- and post-rerank via `inspect()`.

## Logging & Observability

Logging uses [pino](https://getpino.io), pretty-printed in dev via `pino-pretty`, at two levels:

- **System level** — `pino-http` middleware in `server.ts` logs one line per HTTP request/response (method, URL, status code, response time, request id).
- **Component level** — `rag.ts`, `ingest.ts`, and `server.ts` each get a child logger via `logger.child({ component: "..." })`. Inside `ask()`, every pipeline stage (retrieve, rerank, generate) logs its own candidate count and duration, so a slow or failing request can be traced to a specific stage rather than just "the request took 2s" or "it errored".

Example output for a single `/chat` request:

```
[INFO] retrieved candidates   component=rag   stage=retrieve count=20 ms=45
[INFO] reranked candidates    component=rag   stage=rerank   count=5  ms=320
[INFO] generated answer       component=rag   stage=generate          ms=890
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
│   ├── rag.ts          # Retrieve → rerank → generate; exports ask() and inspect()
│   └── server.ts       # Express server with POST /chat
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
  "sources": ["filename.md"]
}
```

| Status | Meaning |
|---|---|
| `400` | `question` missing or empty |
| `500` | Internal error — check server logs |
