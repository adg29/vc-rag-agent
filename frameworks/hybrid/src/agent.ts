/**
 * Hybrid retrieval agent — private corpus + public web/EDGAR
 *
 * Every answer cites sources and distinguishes:
 *   [private:filename:lines]  — from internal deal records
 *   [public:source:id]        — from SEC filings or web search
 *
 * When private and public data conflict, the agent surfaces both versions.
 * This is the core faithfulness problem at production scale.
 */

import Anthropic from "@anthropic-ai/sdk";
import readline from "readline";
import { searchPrivate, searchEdgar, searchWeb, Chunk } from "./tools.js";

const SYSTEM = `You are a research agent for a venture capital firm with access to two types of sources:

1. PRIVATE RECORDS: Internal deal notes, meeting transcripts, emails, and founder updates [private:filename:lines]
2. PUBLIC SOURCES: SEC filings, Crunchbase, news, and web sources [public:source:id]

RULES:
- Cite every factual claim. Format: [private:filename:lines] or [public:source:url]
- Clearly distinguish which facts come from private records vs. public sources
- When private and public data conflict on a fact, surface BOTH and flag the discrepancy
- If neither source supports an answer, say "I don't know"
- Never blend facts from different sources without attribution`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_private",
    description: "Search internal VC records: deal notes, meeting transcripts, emails, founder updates. Use this first for questions about companies we've met with or invested in.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, topK: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "search_public",
    description: "Search public sources: SEC EDGAR filings and web search. Use for external validation, public funding data, or facts not in private records.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: { type: "string", enum: ["edgar", "web", "both"], description: "Which public source to search" },
      },
      required: ["query"],
    },
  },
];

async function executeTool(name: string, input: any): Promise<string> {
  if (name === "search_private") {
    const results = await searchPrivate(input.query, input.topK ?? 6);
    if (!results.length) return "No private records found for this query.";
    return results.map(r => `${r.citation}\n${r.text}`).join("\n\n---\n\n");
  }

  if (name === "search_public") {
    const source = input.source || "both";
    const results: Chunk[] = [];

    if (source === "edgar" || source === "both") {
      results.push(...await searchEdgar(input.query));
    }
    if (source === "web" || source === "both") {
      results.push(...await searchWeb(input.query));
    }

    if (!results.length) return "No public records found for this query.";
    return results.map(r => `${r.citation}${r.url ? ` (${r.url})` : ""}\n${r.text}`).join("\n\n---\n\n");
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function run() {
  const client = new Anthropic({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY!,
  });

  const messages: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(r => rl.question(q, r));

  console.log("Hybrid agent: private records + public sources (SEC EDGAR + web)");
  console.log('Try: "What is the latest on Acme?" or "Find SEC filings for BrightLoop"\n');

  while (true) {
    const input = await ask("You: ");
    if (input.toLowerCase() === "exit") break;
    if (!input.trim()) continue;

    messages.push({ role: "user", content: input });

    while (true) {
      const resp = await client.messages.create({
        model: "anthropic/claude-haiku-4.5",
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });

      const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      if (!toolUses.length) {
        const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
        console.log(`\nAgent: ${text}\n`);
        messages.push({ role: "assistant", content: resp.content });
        break;
      }

      messages.push({ role: "assistant", content: resp.content });
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        process.stdout.write(`  [${tu.name}: "${(tu.input as any).query}"]\n`);
        const result = await executeTool(tu.name, tu.input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }

      messages.push({ role: "user", content: results });
    }
  }

  rl.close();
}

run().catch(console.error);
