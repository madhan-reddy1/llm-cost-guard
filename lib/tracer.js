// Cost tracing — Langfuse-style per-request observability, in-process.
//
// Every request through the proxy is recorded: model, tokens, cost, cache
// status, latency. GET /stats aggregates those events into the numbers a
// team actually watches: hit rate, tokens saved, dollars saved vs. the
// "naive" baseline (every request straight to the flagship model, no cache).
//
// Baseline math (per request):
//   baselineCost = what the request would have cost on azure-gpt with the
//                  same token counts and NO cache
//   actualCost   = what it really cost (0 on a cache hit, provider cost else)
//   saved        = baselineCost - actualCost
// Tokens saved are counted the same way: a cache hit saves the full
// prompt + completion tokens; routing to the economy model saves the
// cost difference (tokens are the same, dollars are not).

const { costFor, FLAGSHIP_MODEL } = require('./pricing');

class Tracer {
  constructor() {
    this.events = [];
  }

  record(event) {
    this.events.push({
      ts: new Date().toISOString(),
      model: event.model,
      cacheStatus: event.cacheStatus, // 'miss' | 'exact' | 'semantic'
      promptTokens: event.promptTokens,
      completionTokens: event.completionTokens,
      cost: event.cost,
      baselineCost: event.baselineCost,
      latencyMs: event.latencyMs,
      routedTier: event.routedTier || null,
    });
  }

  stats() {
    const total = this.events.length;
    const exactHits = this.events.filter((e) => e.cacheStatus === 'exact').length;
    const semanticHits = this.events.filter((e) => e.cacheStatus === 'semantic').length;
    const cacheHits = exactHits + semanticHits;
    const misses = total - cacheHits;

    let tokensUsed = 0;
    let tokensSaved = 0;
    let spent = 0;
    let baseline = 0;
    let latencyTotal = 0;
    const perModel = {};

    for (const e of this.events) {
      const used = e.promptTokens + e.completionTokens;
      tokensUsed += e.cacheStatus === 'miss' ? used : 0;
      // A cache hit avoids the whole round-trip: prompt + completion tokens.
      tokensSaved += e.cacheStatus === 'miss' ? 0 : used;
      spent += e.cost;
      baseline += e.baselineCost;
      latencyTotal += e.latencyMs || 0;

      const key = e.cacheStatus === 'miss' ? e.model : `${e.model} (cache)`;
      perModel[key] = perModel[key] || { requests: 0, tokens: 0, cost: 0 };
      perModel[key].requests += 1;
      perModel[key].tokens += used;
      perModel[key].cost += e.cost;
    }

    const dollarsSaved = baseline - spent;
    const savingsPct = baseline > 0 ? (dollarsSaved / baseline) * 100 : 0;

    return {
      requests: total,
      cache: {
        hits: cacheHits,
        exactHits,
        semanticHits,
        misses,
        hitRate: total > 0 ? cacheHits / total : 0,
        exactHitRate: total > 0 ? exactHits / total : 0,
        semanticHitRate: total > 0 ? semanticHits / total : 0,
      },
      tokens: {
        used: tokensUsed,
        saved: tokensSaved,
      },
      cost: {
        spent: round6(spent),
        baseline: round6(baseline),
        saved: round6(dollarsSaved),
        savingsPct: Math.round(savingsPct * 100) / 100,
        currency: 'USD',
      },
      latency: {
        avgMs: total > 0 ? Math.round(latencyTotal / total) : 0,
      },
      perModel,
      note: 'Demo figures: mock providers, sample prompts. Savings are measured against the flagship model with no cache.',
    };
  }

  // The most recent events, newest first — handy for debugging / demos.
  recent(limit = 20) {
    return this.events.slice(-limit).reverse();
  }
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Baseline cost for a request: same tokens, flagship model, no cache.
function baselineCostFor(promptTokens, completionTokens) {
  return costFor(FLAGSHIP_MODEL, promptTokens, completionTokens);
}

module.exports = { Tracer, baselineCostFor };
