// Mock provider adapters.
//
// There are no real API keys in this project, so the two providers are
// MOCK implementations that behave like the real thing:
//  - they accept { model, messages } and return { content, usage }
//  - token counts are estimated the same way a client would (~4 chars/token)
//  - cost is computed from the real list prices in lib/pricing.js
//
// Swapping in a real provider is a one-file change: implement the same
// `complete()` interface against the provider's SDK/HTTP API (see README),
// and set PROVIDER_MODE=real with the provider's API key in env vars.
// The server, cache, router and tracer never need to change.

const { costFor } = require('./pricing');

// Rough token estimate used by most clients: ~4 characters per token.
// Good enough for a demo; real providers return exact usage.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// A short, plausible canned body per provider so demo responses read like
// real model output instead of lorem ipsum.
function cannedBody(model, prompt) {
  const short = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt;
  if (model === 'gemini-flash') {
    return (
      `[gemini-flash] Quick answer for: "${short}"\n` +
      `This is a concise response from the economy tier. For a short, ` +
      `well-scoped question like this one, the cheap model is the right call — ` +
      `same answer, a fraction of the cost.`
    );
  }
  return (
    `[azure-gpt] Detailed answer for: "${short}"\n` +
    `This is a thorough, step-by-step response from the flagship tier. ` +
    `The prompt was classified as complex, so it was routed here for deeper ` +
    `reasoning, code handling, and structured output.`
  );
}

async function complete({ model, messages }) {
  const prompt = (messages || [])
    .filter((m) => m && m.role === 'user')
    .map((m) => m.content)
    .join('\n');

  const promptTokens = estimateTokens(prompt);
  const content = cannedBody(model, prompt);
  // Completion length scales a little with the prompt so token math is not
  // identical on every call; flagship answers are longer (they cost more).
  const completionTokens = estimateTokens(content);
  const cost = costFor(model, promptTokens, completionTokens);

  // Tiny artificial latency so the tracer has something real to measure.
  const latencyMs = model === 'gemini-flash' ? 40 + Math.floor(Math.random() * 40) : 180 + Math.floor(Math.random() * 120);
  await new Promise((r) => setTimeout(r, latencyMs));

  return {
    model,
    content,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    cost,
    latencyMs,
  };
}

// The two mock adapters share one implementation; they exist as separate
// named exports so a real Gemini / Azure OpenAI adapter can replace either
// one without touching the server.
const gemini = { name: 'gemini-flash', complete: (args) => complete({ ...args, model: 'gemini-flash' }) };
const azureOpenAI = { name: 'azure-gpt', complete: (args) => complete({ ...args, model: 'azure-gpt' }) };

function providerFor(model) {
  if (model === 'gemini-flash') return gemini;
  if (model === 'azure-gpt') return azureOpenAI;
  throw new Error(`No provider adapter for model: ${model}`);
}

module.exports = { gemini, azureOpenAI, providerFor, estimateTokens, complete };
