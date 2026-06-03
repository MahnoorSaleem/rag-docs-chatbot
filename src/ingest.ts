import "./config.js";
import { vectorStore } from "./config.js";
import {
  Document,
  VectorStoreIndex,
  storageContextFromDefaults,
  type BaseNode,
} from "llamaindex";
import { ChromaClient } from "chromadb";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_PATH = path.join(__dirname, "../docs");

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function loadDocuments(dirPath: string): Promise<Document[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const docs: Document[] = [];

  for (const entry of entries.filter((e) => e.isFile())) {
    const filePath = path.join(dirPath, entry.name);
    const raw = await fs.readFile(filePath, "utf-8");

    // Split by ## sections — one Document per section, skip header-only preamble
    const sections = raw.split(/(?=^## )/m).filter((s) => s.trim());

    for (let i = 0; i < sections.length; i++) {
      const text = stripMarkdown(sections[i] ?? "");
      if (text.split("\n").filter((l) => l.trim()).length < 3) continue;
      docs.push(
        new Document({
          text,
          id_: `${filePath}#${i}`,
          metadata: { source: entry.name },
          excludedEmbedMetadataKeys: ["source"],
        }),
      );
    }
  }

  return docs;
}

async function clearCollection() {
  const client = new ChromaClient({ path: process.env.CHROMA_URL ?? "http://localhost:8000" });
  const collections = await client.listCollections();
  if (collections.some((c: unknown) => (typeof c === "string" ? c : (c as any).name) === "doc-chatbot-v2")) {
    await client.deleteCollection({ name: "doc-chatbot-v2" });
    console.log("Cleared doc-chatbot-v2.");
  }
}

async function main() {
  await clearCollection();
  const documents = await loadDocuments(DOCS_PATH);

  console.log(`Split into ${documents.length} section(s)`);
  documents.forEach((doc, i) => {
    const preview = doc.text.split("\n")[0];
    console.log(`  #${i + 1} [${(doc.metadata as any).source}] "${preview}"`);
  });

  const storageContext = await storageContextFromDefaults({ vectorStore });
  await VectorStoreIndex.init({ nodes: documents as unknown as BaseNode[], storageContext });
  console.log("Done.");
}

main().catch(console.error);
