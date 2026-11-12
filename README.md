# 💸 llm-cost-guard

A drop-in **OpenAI-compatible LLM proxy** that cuts LLM spend with a **semantic cache** and **smart model routing** — plus live cost tracing so you can see exactly what you saved.

Point your existing OpenAI client at it, change nothing else, and pay less:

```
your app  ── POST /v1/chat/completions ──▶  llm-cost-guard  ──▶  Gemini Flash / Azure GPT
                                              │  semantic cache (TF-IDF)
                                              │  complexity router
                                              └─ GET /stats (cost tracing)
```

## The problem

Companies' LLM bills are exploding, and most of the spend is waste:

- **Repeat questions.** Users ask the same thing in slightly different words — and every rewording is a fresh, full-price API call.
- **Overkill routing.** Simple questions ("What is the capital of France?") get sent to the most expensive flagship model because there is no routing at all.
- **No visibility.** Nobody can say, per request, what it cost, what it *would* have cost, or how much caching saved.

llm-cost-guard attacks all three: a semantic cache absorbs repeats and near-duplicates, a complexity classifier routes simple prompts to a cheap model, and every request is traced with tokens, cost, and savings vs. the "naive" baseline (everything straight to the flagship model, no cache).

## How it works

### 1. Semantic cache (TF-IDF cosine similarity)

Before any model is called, the prompt is checked against an in-memory cache:

- **Exact hit** — the normalized prompt matches a cached prompt exactly.
- **Semantic hit** — otherwise the prompt is compared to every cached prompt with **TF-IDF cosine similarity** (real TF-IDF: term frequency per prompt, inverse document frequency over the cache, stopwords dropped, light stemming). If the best score is at or above the threshold (default `0.60`), the cached response is reused.

A hit returns the cached response with **0 tokens and $0 cost**. Exact and semantic hits are tracked separately in `/stats`.

Example: `"What is the capital of France?"` → miss. `"What's the capital city of France?"` → semantic hit (same content words, different filler).

### 2. Smart routing (explainable complexity classifier)

On a cache miss, a heuristic classifier scores the prompt on signals that genuinely predict how much model capability is needed:

| Signal | What it looks for | Points |
|---|---|---|
| Length | >50 words, >120 words | +1 to +3 |
| Code | fenced blocks, `function`/`import`/`return`, braces | +3 |
| Multi-step | "step by step", "compare", "design", "debug", "refactor" | +2 |
| Reasoning | "why", "prove", "tradeoff", "analyze", "in depth" | +2 |
| Structured output | "JSON", "table", "bullet points" | +1 |

Score ≥ 6 → **flagship** (`azure-gpt`, GPT-4o class). Below that → **economy** (`gemini-flash`, ~25× cheaper). Every routing decision returns its score and reasons, so it is auditable — the same transparency a real routing layer needs.

### 3. Cost tracing (Langfuse-style observability)

Every request is logged with model, tokens, cost, cache status, and latency. `GET /stats` aggregates them:

- requests, cache hit rate (exact + semantic separately)
- tokens used vs. tokens saved
- dollars spent vs. the flagship baseline, dollars saved, savings %
- per-model breakdown, plus recent requests

## Tech stack

- **Node.js + Express** — the proxy server
- **TF-IDF / cosine similarity** — offline semantic cache (no embedding service needed)
- **Mock Gemini + mock Azure OpenAI adapters** — realistic pricing, swappable for real providers
- **GitHub Actions** — CI runs the demo and asserts savings

## Setup

```bash
git clone https://github.com/madhan-reddy1/llm-cost-guard.git
cd llm-cost-guard
npm install
npm start
# llm-cost-guard listening on http://localhost:3000
```

No API keys needed — the providers are mocks. Set `PORT` and `CACHE_THRESHOLD` via env vars if you want different values (defaults: `3000`, `0.60`).

## Usage

Drop-in replacement for the OpenAI API — just change the base URL:

```bash
# Chat completion (OpenAI-compatible request shape)
curl -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"What is the capital of France?"}]}'

# Same question, reworded — served from the semantic cache, $0
curl -X POST http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"What is the capital city of France?"}]}'

# Cost + cache observability
curl http://localhost:3000/stats
```

### Example `/stats` output

```json
{
  "requests": 10,
  "cache": {
    "hits": 5,
    "exactHits": 1,
    "semanticHits": 4,
    "misses": 5,
    "hitRate": 0.5,
    "exactHitRate": 0.1,
    "semanticHitRate": 0.4
  },
  "tokens": { "used": 1234, "saved": 987 },
  "cost": {
    "spent": 0.00042,
    "baseline": 0.0021,
    "saved": 0.00168,
    "savingsPct": 80,
    "currency": "USD"
  },
  "perModel": {
    "gemini-flash": { "requests": 3, "tokens": 900, "cost": 0.0002 },
    "azure-gpt": { "requests": 2, "tokens": 334, "cost": 0.00022 },
    "gemini-flash (cache)": { "requests": 4, "tokens": 800, "cost": 0 },
    "azure-gpt (cache)": { "requests": 1, "tokens": 187, "cost": 0 }
  }
}
```

### Demo

The demo fires 10 sample prompts — including exact repeats and near-duplicates — and prints the savings summary:

```bash
npm start      # terminal 1
npm run demo   # terminal 2
```

## Project structure

```
.
├── server.js                  # Express app: /v1/chat/completions, /stats, /health
├── demo.js                    # Sample prompts incl. near-duplicates; prints savings
├── lib/
│   ├── cache.js               # Semantic cache: TF-IDF cosine similarity, exact + semantic hits
│   ├── router.js              # Complexity classifier + tier routing (explainable)
│   ├── providers.js           # Mock Gemini + mock Azure OpenAI adapters
│   ├── pricing.js             # Per-model $/1M token prices + flagship baseline
│   └── tracer.js              # Per-request cost/latency logging + stats aggregation
└── .github/workflows/ci.yml   # CI: install, start server, run demo, assert savings
```

## Swapping in real providers

The mock adapters exist so the project runs with zero setup. To point at real models, implement the same `complete({ model, messages })` interface in `lib/providers.js` against the real SDK/HTTP API, and read the key from env vars — never commit one:

```js
// lib/providers.js — example shape for a real adapter
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
async function complete({ model, messages }) {
  // ... call the real API, return { model, content, usage, cost, latencyMs }
}
```

Then set `GEMINI_API_KEY` / `AZURE_OPENAI_API_KEY` (and endpoint) in your environment. The server, cache, router, and tracer do not need to change — they only depend on the adapter interface. Prices in `lib/pricing.js` mirror public list pricing; update them if list prices move.

## Skills demonstrated

- **Semantic caching** — TF-IDF cosine similarity over prompts, exact vs. semantic hit tracking
- **Vector similarity** — TF-IDF vectors and cosine scoring, offline, no embedding service
- **Smart model routing** — explainable complexity classification, tiered models
- **Langfuse-style cost tracing** — per-request tokens/cost/latency, baseline-vs-actual savings math
- **Gemini + Azure OpenAI** — provider adapters with realistic per-model pricing
- **OpenAI-compatible API design** — drop-in `/v1/chat/completions`
- **CI/CD** — GitHub Actions workflow that boots the server, runs the demo, and asserts savings

## Honesty note

All providers in this repo are **mocks** and the demo prompts are **samples**. Dollar figures from the demo show how the savings math works — they are not production traffic. With real providers wired in, the same `/stats` endpoint reports real spend and real savings.
