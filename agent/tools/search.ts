import { defineTool } from "eve/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const INDEX_PATH = path.join(process.cwd(), "data", "index.json");

interface Chunk {
  id: string; filename: string; lineStart: number; lineEnd: number;
  text: string; embedding?: number[]; metadata: Record<string, string>;
}

async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`Embedding error ${res.status}: ${await res.text()}`);
  const d = await res.json() as { data: { embedding: number[] }[] };
  return d.data.map(x => x.embedding);
}

function cosine(a: number[], b: number[]): number {
  let dot=0, na=0, nb=0;
  for (let i=0; i<a.length; i++) { dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export default defineTool({
  description: "Search the corpus of internal VC records (emails, meeting notes, deal memos, founder updates). Returns relevant chunks with source citations. Always search before making any factual claim.",
  inputSchema: z.object({
    query: z.string().describe("Natural language search query"),
    topK: z.number().optional().default(6).describe("Results to return (max 10)"),
  }),
  async execute({ query, topK }) {
    if (!fs.existsSync(INDEX_PATH)) return { error: "Index not built. Run: npm run index" };
    const chunks: Chunk[] = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    const [qe] = await embed([query]);
    const results = chunks
      .filter(c => c.embedding)
      .map(c => ({ ...c, score: cosine(qe, c.embedding!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(topK ?? 6, 10))
      .map(({ embedding: _, score, ...r }) => ({
        citation: `[${r.filename}:${r.lineStart}-${r.lineEnd}]`,
        filename: r.filename, lineStart: r.lineStart, lineEnd: r.lineEnd,
        metadata: r.metadata, text: r.text,
        relevance: Math.round(score * 1000) / 1000,
      }));
    return results.length ? { results } : { results: [], message: "No relevant records found." };
  },
});
