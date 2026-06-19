# Hybrid Retrieval Agent

Extends the base agent with two search tools: private corpus + public sources.

## Architecture

```
Question
   │
   ├── search_private(query)
   │     └── cosine search over data/records/ (local embedded corpus)
   │         → citations: [private:filename:lines]
   │
   └── search_public(query, source="edgar"|"web"|"both")
         ├── SEC EDGAR full-text search (free, no key)
         │   → citations: [public:sec.gov/filing-id]
         └── OpenRouter Perplexity web search
             → citations: [public:web:url]
```

## What this tests (beyond the base 5 evals)

| Eval | Tests |
|---|---|
| 6-source-attribution | Agent uses `[private:]` and `[public:]` citation formats correctly |
| 7-cross-source-conflict | Agent surfaces disagreements between private records and public data |
| 8-i-dont-know-hybrid | Agent refuses when neither source has the answer |

## Why this matters

In production, private data (Attio records, email threads, deal notes) and
public data (SEC filings, news, Crunchbase) will often partially overlap and
sometimes conflict. A Crunchbase entry might say a company raised $3.8M; your
meeting notes say the founder corrected it to $4M on the call. The agent must
surface that discrepancy, not silently pick one.

This is also the architecture that aligns with DRACO-style benchmarking:
DRACO's Finance and Academic questions require citing primary sources (10-Ks,
rating agency reports) alongside any private knowledge. A hybrid agent that
correctly attributes facts to their source type — and flags conflicts — would
pass DRACO's citation quality rubric.

## Setup

```bash
npm install
# Shared index must be built first (run from repo root):
# npm run index

OPENROUTER_API_KEY=sk-or-... npm run start
OPENROUTER_API_KEY=sk-or-... npm run evals
```
