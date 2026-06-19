/**
 * Hybrid eval suite — extends the base 5 evals with 3 new hybrid-specific ones:
 *
 * 6. source-attribution: agent distinguishes [private:] vs [public:] citations
 * 7. cross-source-conflict: surfaces discrepancy between private record and public data
 * 8. i-dont-know-hybrid: refuses when neither source has the answer
 */

import Anthropic from "@anthropic-ai/sdk";
import { searchPrivate, searchWeb, Chunk } from "./tools.js";

const OR_KEY = process.env.OPENROUTER_API_KEY!;

const SYSTEM = `You are a research agent for a venture capital firm with access to two types of sources:
1. PRIVATE RECORDS: Internal deal notes, meeting transcripts, emails [private:filename:lines]
2. PUBLIC SOURCES: SEC filings, web sources [public:source:url]

RULES: Cite every claim. Distinguish private vs public sources. When they conflict, surface both. Say "I don't know" when neither supports an answer.`;

async function ask(question: string, usePublic = false): Promise<string> {
  const client = new Anthropic({ baseURL: "https://openrouter.ai/api/v1", apiKey: OR_KEY });
  const privateResults = await searchPrivate(question, 8);
  const privateContext = privateResults.map(r => `${r.citation}\n${r.text}`).join("\n\n---\n\n");

  let publicContext = "";
  if (usePublic) {
    const webResults = await searchWeb(question, 2);
    publicContext = webResults.map(r => `${r.citation}\n${r.text}`).join("\n\n---\n\n");
  }

  const content = `PRIVATE RECORDS:\n${privateContext || "No relevant private records."}\n\n${usePublic ? `PUBLIC SOURCES:\n${publicContext || "No public results."}\n\n` : ""}QUESTION: ${question}`;

  const resp = await client.messages.create({
    model: "anthropic/claude-haiku-4.5",
    max_tokens: 800,
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  return (resp.content[0] as Anthropic.TextBlock).text;
}

const evals = [
  // ── Base 5 (same as before, private only) ────────────────────────────────
  {
    name: "1-citation-accuracy",
    question: "Who are the founders of BrightLoop and what are their backgrounds?",
    usePublic: false,
    checks: [
      { desc: "cites private brightloop-meeting", fn: (r: string) => /private:brightloop-meeting/.test(r) },
      { desc: "mentions Marcus Webb", fn: (r: string) => /Marcus/i.test(r) },
      { desc: "mentions Lena Park", fn: (r: string) => /Lena/i.test(r) },
      { desc: "cites Stripe background", fn: (r: string) => /Stripe/i.test(r) },
      { desc: "cites Temporal background", fn: (r: string) => /Temporal/i.test(r) },
    ],
  },
  {
    name: "2-conflict-detection",
    question: "How much did Acme raise in their seed round?",
    usePublic: false,
    checks: [
      { desc: "mentions $3.8M", fn: (r: string) => /3\.8/.test(r) },
      { desc: "mentions $4M correction", fn: (r: string) => /\$4M|\b4M\b|final close was \$4|raised \$4/i.test(r) },
      { desc: "flags discrepancy", fn: (r: string) => /discrepan|conflict|corrected|two.*source|however/i.test(r) },
      { desc: "cites private intro email", fn: (r: string) => /private:acme-intro-email/.test(r) },
      { desc: "cites private meeting notes", fn: (r: string) => /private:acme-meeting/.test(r) },
    ],
  },
  {
    name: "3-multi-hop",
    question: "Who introduced us to BrightLoop and who led the investment recommendation?",
    usePublic: false,
    checks: [
      { desc: "identifies Nikhita as intro", fn: (r: string) => /Nikhita/i.test(r) },
      { desc: "identifies Mir as recommender", fn: (r: string) => /Mir/i.test(r) },
      { desc: "cites private intro email", fn: (r: string) => /private:brightloop-intro-email/.test(r) },
      { desc: "cites private deal note", fn: (r: string) => /private:brightloop-deal-note/.test(r) },
    ],
  },
  {
    name: "4-i-dont-know-private",
    question: "What is Nexus Health's current ARR?",
    usePublic: false,
    checks: [
      { desc: "declines / no data", fn: (r: string) => /don.t know|no.*ARR|not.*record|no information/i.test(r) },
      { desc: "does not invent a figure", fn: (r: string) => !/current ARR.*\$\d|ARR is \$/i.test(r) },
      { desc: "cites a nexus-health record", fn: (r: string) => /nexus-health/.test(r) },
    ],
  },
  {
    name: "5-name-dedup",
    question: "Who is Priya Nair?",
    usePublic: false,
    checks: [
      { desc: "mentions Acme CTO Priya", fn: (r: string) => /Acme/i.test(r) && /CTO/i.test(r) },
      { desc: "mentions Nexus Health Priya", fn: (r: string) => /Nexus/i.test(r) },
      { desc: "flags two different people", fn: (r: string) => /two|different|same name|both|another/i.test(r) },
    ],
  },
  // ── Hybrid-specific evals ─────────────────────────────────────────────────
  {
    name: "6-source-attribution",
    question: "What do we know about BrightLoop from our own records vs what's publicly available?",
    usePublic: true,
    checks: [
      { desc: "uses [private:] citation format", fn: (r: string) => /\[private:/.test(r) },
      { desc: "uses [public:] citation format", fn: (r: string) => /\[public:/.test(r) },
      { desc: "explicitly distinguishes source types", fn: (r: string) => /private|internal|our records|public|external|web/i.test(r) },
      { desc: "BrightLoop facts from private records cited", fn: (r: string) => /private:brightloop/.test(r) },
    ],
  },
  {
    name: "7-cross-source-conflict",
    question: "Find any information about Acme AI's funding from both our deal notes and any public sources. Do they agree?",
    usePublic: true,
    checks: [
      { desc: "cites private source for funding", fn: (r: string) => /private:acme/.test(r) },
      { desc: "mentions public source", fn: (r: string) => /\[public:/.test(r) },
      { desc: "attempts to compare or reconcile sources", fn: (r: string) => /agree|disagree|match|conflict|discrepan|differ|consistent|both.*say|public.*say|private.*say|our.*record|external/i.test(r) },
    ],
  },
  {
    name: "8-i-dont-know-hybrid",
    question: "What is Vault Protocol's last quarterly revenue figure from our records or any public source?",
    usePublic: true,
    checks: [
      { desc: "acknowledges no data in private records", fn: (r: string) => /don.t know|not.*in.*record|no.*information|no.*revenue|pre.?revenue|cannot find/i.test(r) },
      { desc: "does not fabricate a revenue figure", fn: (r: string) => !/revenue.*\$\d+[KMB]?|\$\d+[KMB]?.*revenue/i.test(r) || /pre.?revenue|not.*revenue|no.*revenue/i.test(r) },
    ],
  },
];

async function main() {
  let totalPassed = 0, totalChecks = 0;

  for (let i = 0; i < evals.length; i++) {
    const ev = evals[i];
    if (i > 0) await new Promise(r => setTimeout(r, 2000));

    console.log(`\n${"=".repeat(60)}\nEVAL ${i+1}/${evals.length}: ${ev.name}\nQ: ${ev.question}\nSources: ${ev.usePublic ? "private + public" : "private only"}\n${"=".repeat(60)}`);

    let reply = "";
    try {
      reply = await ask(ev.question, ev.usePublic);
      console.log(`\nAGENT REPLY:\n${reply}\n`);
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`);
      totalChecks += ev.checks.length;
      for (const c of ev.checks) console.log(`  ✗ ${c.desc}`);
      continue;
    }

    let passed = 0;
    for (const check of ev.checks) {
      const ok = check.fn(reply);
      console.log(`  ${ok ? "✓" : "✗"} ${check.desc}`);
      if (ok) passed++;
    }
    console.log(`\n  Result: ${passed}/${ev.checks.length}`);
    totalPassed += passed;
    totalChecks += ev.checks.length;
  }

  console.log(`\n${"=".repeat(60)}\nFINAL: ${totalPassed}/${totalChecks} passed\n${"=".repeat(60)}`);
}

main().catch(console.error);
