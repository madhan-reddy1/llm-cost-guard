// Demo: fires a set of sample prompts at a running llm-cost-guard server
// and prints the savings summary from GET /stats.
//
// The prompt set is deliberately built to exercise all three paths:
//  - exact cache hits  (the same prompt twice)
//  - semantic hits     (near-duplicates: same question, different wording)
//  - smart routing     (simple -> gemini-flash, complex -> azure-gpt)
//
// Usage:
//   1. npm start            (in another terminal)
//   2. npm run demo
//   Or: DEMO_URL=http://localhost:3000 node demo.js
//
// NOTE: all prompts are samples and all providers are mocks, so the dollar
// figures are DEMO figures — they show how the math works, not production
// traffic.

const BASE_URL = process.env.DEMO_URL || 'http://localhost:3000';

const PROMPTS = [
  // Simple -> economy tier, then exact + semantic cache hits on repeats.
  { label: 'simple #1 (economy, miss)', prompt: 'What is the capital of France?' },
  { label: 'simple #1 again (exact hit)', prompt: 'What is the capital of France?' },
  { label: 'simple #1 reworded (semantic hit)', prompt: "What's the capital city of France?" },
  { label: 'simple #2 (economy, miss)', prompt: 'Explain photosynthesis in simple terms.' },
  { label: 'simple #2 reworded (semantic hit)', prompt: 'Explain photosynthesis in simple words.' },
  { label: 'simple #3 (economy, miss)', prompt: 'How do I reset my password?' },
  { label: 'simple #3 reworded (semantic hit)', prompt: 'How can I reset my account password?' },
  // Complex -> flagship tier.
  {
    label: 'complex #1 (flagship, miss)',
    prompt:
      'Write a Python function that implements a binary search tree with insert and delete, ' +
      'then explain step by step the time complexity of each operation and the tradeoffs ' +
      'versus a hash table. Compare the two approaches and give pros and cons.',
  },
  {
    label: 'complex #2 (flagship, miss)',
    prompt:
      'Debug this code: ```js\nfunction getUser(id) { return db.query("SELECT * FROM users WHERE id = " + id); }\n``` ' +
      'Explain why it is vulnerable, refactor it to use parameterized queries, and design a test plan ' +
      'for the fix step by step.',
  },
  {
    label: 'complex #1 reworded (semantic hit, flagship answer reused)',
    prompt:
      'Implement a binary search tree in Python with insert and delete methods, explain the time ' +
      'complexity of each operation step by step, and compare the tradeoffs versus a hash table.',
  },
];

async function postChat(prompt) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`chat completions failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getStats() {
  const res = await fetch(`${BASE_URL}/stats`);
  if (!res.ok) throw new Error(`stats failed: ${res.status}`);
  return res.json();
}

async function main() {
  console.log('llm-cost-guard demo — firing sample prompts (mock providers, sample data)\n');
  for (const { label, prompt } of PROMPTS) {
    const out = await postChat(prompt);
    const g = out.llm_cost_guard || {};
    const status = g.cached ? `CACHE ${g.cache_type.toUpperCase()}${g.similarity ? ` (sim=${g.similarity})` : ''}` : `MISS -> ${out.model} (${g.routed_tier})`;
    console.log(`- ${label}`);
    console.log(`    ${status} | cost $${(g.cost_usd ?? 0).toFixed(6)} | tokens ${out.usage.total_tokens}`);
  }

  const s = await getStats();
  console.log('\n===== Savings summary (GET /stats) =====');
  console.log(`Requests:            ${s.requests}`);
  console.log(`Cache hits:          ${s.cache.hits} (exact ${s.cache.exactHits}, semantic ${s.cache.semanticHits})`);
  console.log(`Cache hit rate:      ${(s.cache.hitRate * 100).toFixed(1)}%`);
  console.log(`Tokens used:         ${s.tokens.used}`);
  console.log(`Tokens saved:        ${s.tokens.saved}`);
  console.log(`Spent:               $${s.cost.spent}`);
  console.log(`Baseline (flagship, no cache): $${s.cost.baseline}`);
  console.log(`Dollars saved:       $${s.cost.saved} (${s.cost.savingsPct}% cheaper than baseline)`);
  console.log('Per-model breakdown:');
  for (const [model, b] of Object.entries(s.perModel)) {
    console.log(`  ${model}: ${b.requests} req, ${b.tokens} tokens, $${b.cost.toFixed(6)}`);
  }
  console.log('\nNote: demo figures only — mock providers and sample prompts.');
}

main().catch((err) => {
  console.error('Demo failed:', err.message);
  console.error(`Is the server running? Start it with: npm start (then re-run: npm run demo)`);
  process.exit(1);
});
