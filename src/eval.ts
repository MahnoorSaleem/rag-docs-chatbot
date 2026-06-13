import { MetadataMode, Settings } from "llamaindex";
import { logger } from "./logger.js";
import { retrieveAndRerank } from "./rag.js";

const evalLog = logger.child({ component: "eval" });

// Component-level LLM-as-judge: scores whether the retrieved+reranked
// context is sufficient to answer the question, independent of the
// final generated answer.
function buildJudgePrompt(question: string, context: string): string {
  return `You are evaluating whether retrieved context is sufficient to answer a question for a documentation chatbot.

Question: ${question}

Retrieved Context:
---------------------
${context}
---------------------

Score how well the retrieved context covers the question, from 1 to 5:
1 = context is irrelevant to the question
3 = context is partially relevant but missing key information
5 = context fully contains the information needed to answer

Respond with ONLY a JSON object, no other text: {"score": <1-5>, "reasoning": "<one sentence>"}`;
}

interface JudgeResult {
  score: number;
  reasoning: string;
}

function stripCodeFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function judgeContextQuality(question: string, context: string): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(question, context);
  const response = await Settings.llm.chat({ messages: [{ role: "user", content: prompt }] });
  const raw = stripCodeFence(String(response.message.content));

  try {
    return JSON.parse(raw) as JudgeResult;
  } catch {
    evalLog.warn({ question, raw }, "failed to parse judge response");
    return { score: 0, reasoning: "unparseable judge response" };
  }
}

const questions = [
  "How do I reset my API key?",
  "What are the installation steps?",
  "What HTTP error codes exist?",
  // In-scope, single-section
  "What is the default rate limit and what happens if I exceed it?",
  "How do I delete a user?",
  "What should I do if installation fails?",
  // In-scope, answer spans multiple doc sections
  "How do I store my API key securely and rotate it?",
  // Out of scope — context should score low
  "How do I deploy this package to a Kubernetes cluster?",
  "What's the capital of France?",
];

const results: { question: string; score: number; reasoning: string }[] = [];

for (const question of questions) {
  const { reranked } = await retrieveAndRerank(question);
  const context = reranked
    .map((n) => n.node.getContent(MetadataMode.NONE))
    .join("\n\n---\n\n");

  const { score, reasoning } = await judgeContextQuality(question, context);
  evalLog.info({ stage: "context-quality", question, score, reasoning }, "judged context quality");
  results.push({ question, score, reasoning });
}

const average = results.reduce((sum, r) => sum + r.score, 0) / results.length;
evalLog.info({ stage: "context-quality-summary", average, results }, "context quality eval complete");
