// llm-cost-guard — drop-in OpenAI-compatible LLM proxy.
//
//  POST /v1/chat/completions   OpenAI-compatible chat endpoint
//  GET  /stats                  cost + cache observability (Langfuse-style)
//  GET  /health                 liveness check
//  GET  /                       short service info
//
// Request flow for every chat completion:
//   1. Semantic cache lookup (exact, then TF-IDF cosine similarity).
//      Hit -> return the cached response, 0 tokens, 0 cost.
//   2. Miss -> complexity classifier routes to a tier:
//      simple prompts -> gemini-flash (economy), complex -> azure-gpt.
//   3. Mock provider answers; the response is stored in the cache and the
//      request is traced (tokens, cost, cache status, latency).
//
// No real API keys are used anywhere. Providers are mock adapters; see
// README "Swapping in real providers" to point this at real Gemini /
// Azure OpenAI with env vars.

const express = require('express');
const { SemanticCache } = require('./lib/cache');
const { classify } = require('./lib/router');
const { providerFor, estimateTokens } = require('./lib/providers');
const { Tracer, baselineCostFor } = require('./lib/tracer');
const { FLAGSHIP_MODEL } = require('./lib/pricing');

const PORT = process.env.PORT || 3000;
const CACHE_THRESHOLD = parseFloat(process.env.CACHE_THRESHOLD || '0.60');

const app = express();
app.use(express.json({ limit: '1mb' }));

const cache = new SemanticCache({ threshold: CACHE_THRESHOLD });
const tracer = new Tracer();

function lastUserPrompt(messages) {
  const users = (messages || []).filter((m) => m && m.role === 'user');
  return users.length ? users[users.length - 1].content : '';
}

function openAIResponse({ id, model, content, usage, extra }) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
    ...(extra || {}),
  };
}

app.get('/', (req, res) => {
  res.json({
    service: 'llm-cost-guard',
    description: 'OpenAI-compatible LLM proxy: semantic cache + smart routing + cost tracing.',
    endpoints: ['POST /v1/chat/completions', 'GET /stats', 'GET /health'],
    flagshipBaseline: FLAGSHIP_MODEL,
    cacheThreshold: CACHE_THRESHOLD,
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/v1/chat/completions', async (req, res) => {
  const started = Date.now();
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' } });
  }
  const prompt = lastUserPrompt(messages);
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: { message: 'no user message found', type: 'invalid_request_error' } });
  }

  // 1. Semantic cache.
  const hit = cache.lookup(prompt);
  if (hit.hit) {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    // Baseline: what this would have cost on the flagship model with no cache.
    // Record the AVOIDED token counts (estimated) with cost 0, so /stats can
    // report tokens saved; nothing was actually spent.
    const avoidedPromptTokens = estimateTokens(prompt);
    const avoidedCompletionTokens = estimateTokens(hit.response);
    const baseline = baselineCostFor(avoidedPromptTokens, avoidedCompletionTokens);
    tracer.record({
      model: hit.model,
      cacheStatus: hit.type,
      promptTokens: avoidedPromptTokens,
      completionTokens: avoidedCompletionTokens,
      cost: 0,
      baselineCost: baseline,
      latencyMs: Date.now() - started,
      routedTier: 'cache',
    });
    return res.json(
      openAIResponse({
        id: `chatcmpl-cache-${Date.now()}`,
        model: hit.model,
        content: hit.response,
        usage,
        extra: {
          llm_cost_guard: {
            cached: true,
            cache_type: hit.type,
            similarity: hit.type === 'semantic' ? Math.round(hit.similarity * 1000) / 1000 : 1,
            cost_usd: 0,
          },
        },
      })
    );
  }

  // 2. Smart routing by prompt complexity.
  const route = classify(prompt);
  const provider = providerFor(route.model);

  // 3. Mock provider call.
  try {
    const result = await provider.complete({ model: route.model, messages });
    cache.store(prompt, result.content, route.model);
    tracer.record({
      model: route.model,
      cacheStatus: 'miss',
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      cost: result.cost,
      baselineCost: baselineCostFor(result.usage.prompt_tokens, result.usage.completion_tokens),
      latencyMs: Date.now() - started,
      routedTier: route.tier,
    });
    return res.json(
      openAIResponse({
        id: `chatcmpl-${Date.now()}`,
        model: route.model,
        content: result.content,
        usage: result.usage,
        extra: {
          llm_cost_guard: {
            cached: false,
            cache_type: 'miss',
            routed_tier: route.tier,
            routing_score: route.score,
            routing_reasons: route.reasons,
            cost_usd: Math.round(result.cost * 1e6) / 1e6,
          },
        },
      })
    );
  } catch (err) {
    console.error('Provider error:', err);
    return res.status(502).json({ error: { message: 'provider error', type: 'provider_error' } });
  }
});

app.get('/stats', (req, res) => {
  res.json({
    ...tracer.stats(),
    cacheEntries: cache.stats().entries,
    recent: tracer.recent(10),
  });
});

app.listen(PORT, () => {
  console.log(`llm-cost-guard listening on http://localhost:${PORT}`);
  console.log(`  POST /v1/chat/completions  (OpenAI-compatible)`);
  console.log(`  GET  /stats                 (cost + cache observability)`);
  console.log(`  Cache threshold: ${CACHE_THRESHOLD} | Flagship baseline: ${FLAGSHIP_MODEL}`);
});
