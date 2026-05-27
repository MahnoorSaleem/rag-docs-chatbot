import * as dotenv from "dotenv";
import { ChromaVectorStore } from "@llamaindex/chroma";
import {
  HuggingFaceEmbedding,
  HuggingFaceEmbeddingModelType,
} from "@llamaindex/huggingface";
import { Settings } from "llamaindex";

dotenv.config();

Settings.embedModel = new HuggingFaceEmbedding({
  modelType: HuggingFaceEmbeddingModelType.XENOVA_ALL_MINILM_L6_V2,
});

export const vectorStore = new ChromaVectorStore({
  collectionName: "doc-chatbot",
  chromaClientParams: {
    path: process.env.CHROMA_URL ?? "http://localhost:8000",
  },
});
