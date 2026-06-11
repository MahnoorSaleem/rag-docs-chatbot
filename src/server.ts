import "./config.js";
import express from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./logger.js";
import { ask } from "./rag.js";

const app = express();
app.use(express.json());

// System level: one log line per HTTP request/response (method, status, latency, request id).
app.use(pinoHttp({ logger }));

const chatLog = logger.child({ component: "chat" });

app.post("/chat", async (req, res) => {
  const { question } = req.body as { question?: string };

  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  // Component level: how the RAG pipeline behaved for this specific question.
  const start = Date.now();
  try {
    const { answer, sources } = await ask(question);
    chatLog.info(
      {
        question,
        sources,
        answerLength: answer.length,
        ms: Date.now() - start,
      },
      "answered question",
    );
    res.json({ answer, sources });
  } catch (err) {
    chatLog.error(
      { question, err, ms: Date.now() - start },
      "failed to answer question",
    );
    res.status(500).json({ error: "Failed to process question" });
  }
});

const PORT = process.env.PORT ?? 3003;
const server = app.listen(PORT, () =>
  logger.info(`Server running on http://localhost:${PORT}`),
);
server.on("error", (err) => {
  logger.error({ err }, "server failed to start");
  process.exit(1);
});
