// Per-model pricing in USD per 1,000,000 tokens.
// Prices mirror public list pricing as of 2026 for the model classes used:
//  - gemini-flash : Gemini 2.0 Flash class (cheap, fast)
//  - azure-gpt    : GPT-4o class on Azure OpenAI (flagship, premium)
// Update these if list prices change; the mock providers read them from here
// so cost math stays in one place.

const PRICING = {
  'gemini-flash': {
    label: 'Gemini Flash (economy)',
    inputPerMillion: 0.10,
    outputPerMillion: 0.40,
  },
  'azure-gpt': {
    label: 'Azure GPT flagship (premium)',
    inputPerMillion: 2.50,
    outputPerMillion: 10.00,
  },
};

// The flagship model is the cost baseline: "dollars saved" is measured
// against what the same request would have cost on azure-gpt with no cache.
const FLAGSHIP_MODEL = 'azure-gpt';

function costFor(model, promptTokens, completionTokens) {
  const p = PRICING[model];
  if (!p) throw new Error(`Unknown model for pricing: ${model}`);
  return (
    (promptTokens / 1_000_000) * p.inputPerMillion +
    (completionTokens / 1_000_000) * p.outputPerMillion
  );
}

module.exports = { PRICING, FLAGSHIP_MODEL, costFor };
