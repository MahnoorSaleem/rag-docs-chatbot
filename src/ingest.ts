import "./config.js";
import { vectorStore } from "./config.js";
import {
  Document,
  SentenceSplitter,
  VectorStoreIndex,
  storageContextFromDefaults,
  type BaseNode,
} from "llamaindex";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_PATH = path.join(__dirname, "../docs");

async function loadDocuments(dirPath: string): Promise<Document[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (entry) => {
        const filePath = path.join(dirPath, entry.name);
        const text = await fs.readFile(filePath, "utf-8");
        return new Document({ text, id_: filePath, metadata: { source: entry.name } });
      }),
  );
}

function splitIntoNodes(documents: Document[]): BaseNode[] {
  return new SentenceSplitter({ chunkSize: 256, chunkOverlap: 50 }).getNodesFromDocuments(
    documents,
  );
}

async function main() {
  console.log("Loading documents...");
  const documents = await loadDocuments(DOCS_PATH);
  console.log(`Loaded ${documents.length} document(s)`);

  const nodes = splitIntoNodes(documents);
  console.log(`Split into ${nodes.length} chunk(s)`);

  console.log("Embedding and storing in ChromaDB...");
  const storageContext = await storageContextFromDefaults({ vectorStore });
  await VectorStoreIndex.init({ nodes, storageContext });
  console.log("Done.");
}

main().catch(console.error);
