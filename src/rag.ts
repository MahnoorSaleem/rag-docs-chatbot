import { Groq } from "@llamaindex/groq";
import {
  CompactAndRefine,
  MetadataMode,
  PromptTemplate,
  Settings,
  VectorStoreIndex,
  type LLMEndEvent,
} from "llamaindex";
import { JinaAIReranker } from "llamaindex/postprocessors";
import type { NodeWithScore } from "@llamaindex/core/schema";
import { logger } from "./logger.js";
import { vectorStore } from "./config.js";

const ragLog = logger.child({ component: "rag" });

Settings.llm = new Groq({
  model: "llama-3.1-8b-instant",
  temperature: 0,
  apiKey: process.env.GROQ_API_KEY,
});

const reranker = new JinaAIReranker({ topN: 5 });

const qaTemplate = new PromptTemplate({
  templateVars: ["context", "query"],
  template: `You are a helpful documentation assistant.
Answer the question using ONLY the provided context.
If the answer is not in the context, say "I do not know."
Keep answers clear and concise.
Always mention which document the answer came from.

Context:
---------------------
{context}
---------------------
Question: {query}
Answer:`,
});

// Re-initializing the index on every query fetches metadata from ChromaDB each
// time. One module-level instance is enough — the index is read-only at query time.
let cachedIndex: VectorStoreIndex | null = null;

async function getIndex(): Promise<VectorStoreIndex> {
  cachedIndex ??= await VectorStoreIndex.fromVectorStore(vectorStore);
  return cachedIndex;
}

export async function retrieveAndRerank(
  question: string,
): Promise<{ candidates: NodeWithScore[]; reranked: NodeWithScore[] }> {
  const index = await getIndex();

  let start = Date.now();
  const retriever = index.asRetriever({ similarityTopK: 20 });
  const candidates = await retriever.retrieve({ query: question });
  ragLog.info(
    { stage: "retrieve", count: candidates.length, ms: Date.now() - start },
    "retrieved candidates",
  );

  start = Date.now();
  const reranked = await reranker.postprocessNodes(candidates, question);
  ragLog.info(
    { stage: "rerank", count: reranked.length, ms: Date.now() - start },
    "reranked candidates",
  );

  return { candidates, reranked };
}

export async function ask(
  question: string,
): Promise<{ answer: string; sources: string[] }> {
  const { reranked } = await retrieveAndRerank(question);

  const start = Date.now();
  const usage: Record<string, number> = {};
  const onLLMEnd = (event: CustomEvent<LLMEndEvent>) => {
    const callUsage = (event.detail.response.raw as { usage?: Record<string, number> } | null)
      ?.usage;
    for (const [key, value] of Object.entries(callUsage ?? {})) {
      usage[key] = (usage[key] ?? 0) + value;
    }
  };

  Settings.callbackManager.on("llm-end", onLLMEnd);
  let response;
  try {
    const synthesizer = new CompactAndRefine({ textQATemplate: qaTemplate });
    response = await synthesizer.synthesize({ query: question, nodes: reranked });
  } finally {
    Settings.callbackManager.off("llm-end", onLLMEnd);
  }
  ragLog.info({ stage: "generate", ms: Date.now() - start, usage }, "generated answer");

  const sources = (response.sourceNodes ?? [])
    .map((n) => n.node.metadata?.source as string)
    .filter((s, i, arr) => Boolean(s) && arr.indexOf(s) === i);

  return { answer: String(response.message.content), sources };
}

function printRanked(label: string, results: NodeWithScore[]): void {
  console.log(`  ${label}:`);
  results.forEach((r, i) => {
    const score = r.score?.toFixed(3) ?? "n/a";
    const text = r.node
      .getContent(MetadataMode.NONE)
      .slice(0, 100)
      .replace(/\n/g, " ");
    console.log(`    #${i + 1} score=${score} | "${text}"`);
  });
}

export async function inspect(question: string): Promise<void> {
  const { candidates, reranked } = await retrieveAndRerank(question);

  printRanked("Before rerank (top 5 by similarity)", candidates.slice(0, 5));
  printRanked("After rerank (top 5 by relevance)", reranked.slice(0, 5));
}

// Smoke-test runner: `npm run rag`
if (process.argv[1]?.endsWith("rag.ts")) {
  const questions = [
    "How do I reset my API key?",
    "What are the installation steps?",
    "What HTTP error codes exist?",
  ];
  for (const q of questions) {
    console.log(`\nQ: "${q}"`);
    await inspect(q);
    const { answer, sources } = await ask(q);
    console.log(`Answer: ${answer}`);
  }
}
