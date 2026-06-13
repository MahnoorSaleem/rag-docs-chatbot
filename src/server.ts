import "./config.js";
import express from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./logger.js";
import { ask } from "./rag.js";

const app = express();
app.use(express.json());

// System level: one log line per HTTP request/response (method, status, latency, request id).
app.use(pinoHttp({ logger }));

app.post("/chat", async (req, res) => {
  const { question } = req.body as { question?: string };

  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  // Component level: how the RAG pipeline behaved for this specific question.
  const chatLog = req.log.child({ component: "chat" });
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
    res.json({ answer, sources, requestId: req.id });
  } catch (err) {
    chatLog.error(
      { question, err, ms: Date.now() - start },
      "failed to answer question",
    );
    res.status(500).json({ error: "Failed to process question" });
  }
});

// System level: human feedback on a previously answered question, correlated
// by the requestId returned from /chat.
app.post("/feedback", (req, res) => {
  const { requestId, rating } = req.body as { requestId?: string | number; rating?: string };

  if (requestId === undefined || (rating !== "up" && rating !== "down")) {
    res.status(400).json({ error: "requestId and rating ('up' or 'down') are required" });
    return;
  }

  logger.child({ component: "feedback" }).info({ requestId, rating }, "received feedback");
  res.status(204).end();
});

const PORT = process.env.PORT ?? 3003;
const server = app.listen(PORT, () =>
  logger.info(`Server running on http://localhost:${PORT}`),
);
server.on("error", (err) => {
  logger.error({ err }, "server failed to start");
  process.exit(1);
});
