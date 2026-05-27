import { Groq } from "@llamaindex/groq";
import {
  CompactAndRefine,
  PromptTemplate,
  Settings,
  VectorStoreIndex,
} from "llamaindex";
import { vectorStore } from "./config.js";

Settings.llm = new Groq({
  model: "llama-3.1-8b-instant",
  temperature: 0,
  apiKey: process.env.GROQ_API_KEY,
});

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

export async function ask(question: string): Promise<{ answer: string; sources: string[] }> {
  const index = await getIndex();

  const queryEngine = index.asQueryEngine({
    retriever: index.asRetriever({ similarityTopK: 5 }),
    responseSynthesizer: new CompactAndRefine({ textQATemplate: qaTemplate }),
  });

  const response = await queryEngine.query({ query: question });

  const sources = (response.sourceNodes ?? [])
    .map((n) => n.node.metadata?.source as string)
    .filter((s, i, arr) => Boolean(s) && arr.indexOf(s) === i);

  return { answer: String(response.message.content), sources };
}

// Smoke-test runner: `npm run rag`
if (process.argv[1]?.endsWith("rag.ts")) {
  const questions = [
    "How do I reset my API key?",
    "What are the installation steps?",
    "What HTTP error codes exist?",
  ];
  for (const q of questions) {
    console.log(`\nQ: ${q}`);
    const { answer, sources } = await ask(q);
    console.log(`A: ${answer}`);
    console.log(`Sources: ${sources.join(", ")}`);
  }
}
