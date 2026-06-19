/**
 * Dual retrieval tools:
 *   search_private  → embedded local corpus (same as base implementation)
 *   search_public   → EDGAR full-text search + OpenRouter web search
 *
 * Both return the same shape so the agent can cite and reason across them.
 * Conflicts between private and public are surfaced, not resolved silently.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, "../../../data/index.json");
const OR_KEY = process.env.OPENROUTER_API_KEY!;

// ── Shared types ───────────────────────────────────────────────────────────────
export interface Chunk {
  citation: string;       // e.g. [acme-meeting.md:12-18] or [web:sec.gov/...]
  sourceType: "private" | "public";
  text: string;
  relevance?: number;
  url?: string;
}

// ── Embedding + cosine search (private corpus) ────────────────────────────────
async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`Embed error ${res.status}: ${await res.text()}`);
  const d = await res.json() as { data: { embedding: number[] }[] };
  return d.data.map(x => x.embedding);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function searchPrivate(query: string, topK = 6): Promise<Chunk[]> {
  if (!fs.existsSync(INDEX_PATH)) throw new Error("Index not built. Run: npm run index");
  const raw: any[] = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  const [qe] = await embedTexts([query]);
  return raw
    .filter(c => c.embedding)
    .map(c => ({ ...c, score: cosine(qe, c.embedding) }))
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, topK)
    .map(({ embedding: _, score, filename, lineStart, lineEnd, text }: any): Chunk => ({
      citation: `[private:${filename}:${lineStart}-${lineEnd}]`,
      sourceType: "private",
      text,
      relevance: Math.round(score * 1000) / 1000,
    }));
}

// ── EDGAR full-text search (public, free, no key needed) ──────────────────────
export async function searchEdgar(query: string, topK = 3): Promise<Chunk[]> {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=${encoded}&dateRange=custom&startdt=2020-01-01&forms=8-K,10-K,10-Q&hits.hits._source.period_of_report=true`,
      { headers: { "User-Agent": "vc-rag-agent research@asyncvc.com" } }
    );
    if (!res.ok) return [];
    const d = await res.json() as any;
    const hits = (d.hits?.hits || []).slice(0, topK);
    return hits.map((h: any): Chunk => ({
      citation: `[public:sec.gov/${h._id}]`,
      sourceType: "public",
      url: `https://www.sec.gov/Archives/edgar/data/${h._source?.entity_id}/${h._id}`,
      text: `SEC filing: ${h._source?.period_of_report || ""} | ${h._source?.entity_name || ""} | ${h._source?.form_type || ""}\n${h._source?.file_date || ""}`,
      relevance: h._score,
    }));
  } catch {
    return [];
  }
}

// ── Web search via OpenRouter Perplexity (for non-SEC public facts) ────────────
export async function searchWeb(query: string, topK = 3): Promise<Chunk[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OR_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "perplexity/sonar",
        messages: [{ role: "user", content: `Find factual information about: ${query}. Return only key facts with sources.` }],
        max_tokens: 400,
      }),
    });
    if (!res.ok) return [];
    const d = await res.json() as any;
    const text = d.choices?.[0]?.message?.content || "";
    const citations = (d.citations || []) as string[];
    return [{
      citation: citations.length > 0 ? `[public:web:${citations[0]}]` : `[public:web:perplexity-sonar]`,
      sourceType: "public",
      url: citations[0],
      text,
      relevance: 0.8,
    }];
  } catch {
    return [];
  }
}
