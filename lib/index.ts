import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const RECORDS_DIR = path.join(process.cwd(), "data", "records");
const INDEX_PATH = path.join(process.cwd(), "data", "index.json");

interface Chunk {
  id: string;
  filename: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  embedding?: number[];
  metadata: Record<string, string>;
}

function extractMetadata(lines: string[]): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of lines.slice(0, 8)) {
    const m = line.match(/^(Date|Type|From|To|Subject|Author|Re|Attendees):\s*(.+)/i);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

function chunkFile(filename: string, content: string): Omit<Chunk, "embedding">[] {
  const lines = content.split("\n");
  const metadata = extractMetadata(lines);
  const chunks: Omit<Chunk, "embedding">[] = [];
  const CHUNK_LINES = 20, OVERLAP = 4;
  for (let i = 0; i < lines.length; i += CHUNK_LINES - OVERLAP) {
    const end = Math.min(i + CHUNK_LINES, lines.length);
    const text = lines.slice(i, end).join("\n").trim();
    if (text.length < 50) continue;
    chunks.push({
      id: crypto.createHash("md5").update(`${filename}:${i}:${end}`).digest("hex").slice(0, 8),
      filename, lineStart: i + 1, lineEnd: end, text, metadata,
    });
  }
  return chunks;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`Embed error ${res.status}: ${await res.text()}`);
  const data = await res.json() as { data: { embedding: number[] }[] };
  return data.data.map(d => d.embedding);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function buildIndex(): Promise<void> {
  const files = fs.readdirSync(RECORDS_DIR).filter(f => f.endsWith(".md"));
  const allChunks: Chunk[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(RECORDS_DIR, file), "utf-8");
    allChunks.push(...(chunkFile(file, content) as Chunk[]));
  }
  console.log(`Chunked ${allChunks.length} chunks from ${files.length} files. Embedding via OpenRouter...`);
  const batchSize = 50;
  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize);
    const embeddings = await embedTexts(batch.map(c => c.text));
    for (let j = 0; j < batch.length; j++) allChunks[i + j].embedding = embeddings[j];
    process.stdout.write(`  ${Math.min(i + batchSize, allChunks.length)}/${allChunks.length}\r`);
  }
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(allChunks, null, 2));
  console.log(`\nDone: ${allChunks.length} chunks indexed → data/index.json`);
}

export async function search(query: string, topK = 5): Promise<Omit<Chunk, "embedding">[]> {
  if (!fs.existsSync(INDEX_PATH)) throw new Error("Index not built. Run: npm run index");
  const chunks: Chunk[] = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  const [qe] = await embedTexts([query]);
  return chunks
    .filter(c => c.embedding)
    .map(c => ({ ...c, score: cosine(qe, c.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ embedding: _, ...r }) => r);
}
