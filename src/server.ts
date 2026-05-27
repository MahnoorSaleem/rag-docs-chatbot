import "./config.js";
import express from "express";
import { ask } from "./rag.js";

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { question } = req.body as { question?: string };

  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  try {
    const { answer, sources } = await ask(question);
    res.json({ answer, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process question" });
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
