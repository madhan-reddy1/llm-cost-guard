// Complexity classifier + smart model routing.
//
// Routing is a real, explainable heuristic — not random. Each prompt is
// scored on signals that genuinely predict how much model capability a
// request needs, and the score decides the tier:
//
//  - economy  -> "gemini-flash" (cheap, fast; ~25x cheaper than flagship)
//  - flagship -> "azure-gpt"    (premium; reserved for hard requests)
//
// Signals (each returns points plus a human-readable reason):
//  - length: long prompts need more context handling
//  - code: code in the prompt usually means debugging / writing / review
//  - multi-step: "step by step", "first... then", "compare", "design"
//  - reasoning: "why", "prove", "tradeoff", "derive", "explain in detail"
//  - structured output: asking for JSON / a table / a specific format
//
// The returned `reasons` list makes every routing decision auditable —
// the same transparency you would want from a real routing layer.

const ECONOMY_MODEL = 'gemini-flash';
const FLAGSHIP_MODEL = 'azure-gpt';

// Score at or above this routes to the flagship model.
const FLAGSHIP_THRESHOLD = 6;

const CODE_PATTERNS = [
  /```/, // fenced code block
  /\b(function|class|def |import |require\(|const |let |var |return |await |async )\b/i,
  /[{};]\s*$/m, // braces / semicolons typical of code
  /\b(sql|regex|api|json|typescript|python|javascript|node)\b/i,
];

const MULTISTEP_PATTERNS = [
  /step by step/i,
  /\bfirst\b.*\bthen\b/i,
  /\bcompare\b/i,
  /\bdesign\b/i,
  /\barchitect/i,
  /\bplan\b/i,
  /\bdebug\b/i,
  /\brefactor\b/i,
  /\boptimize\b/i,
  /\bmigrate\b/i,
];

const REASONING_PATTERNS = [
  /\bwhy\b/i,
  /\bprove\b/i,
  /\bderive\b/i,
  /\btrade-?off/i,
  /\btradeoff\b/i,
  /\bexplain in detail\b/i,
  /\bin depth\b/i,
  /\bpros and cons\b/i,
  /\bevaluate\b/i,
  /\banalyze\b/i,
];

const STRUCTURED_PATTERNS = [
  /\bjson\b/i,
  /\btable\b/i,
  /\bmarkdown\b/i,
  /\bbullet points\b/i,
  /\bnumbered list\b/i,
];

function countMatches(text, patterns) {
  let hits = 0;
  for (const p of patterns) if (p.test(text)) hits += 1;
  return hits;
}

function classify(prompt) {
  const text = prompt || '';
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  let score = 0;
  const reasons = [];

  // Length: longer prompts usually carry more context and a harder task.
  if (words > 120) { score += 3; reasons.push(`long prompt (${words} words)`); }
  else if (words > 50) { score += 2; reasons.push(`medium prompt (${words} words)`); }
  else if (words > 25) { score += 1; reasons.push(`short-ish prompt (${words} words)`); }

  // Code in the prompt: debugging / writing / review work.
  const codeHits = countMatches(text, CODE_PATTERNS);
  if (codeHits > 0) { score += 3; reasons.push(`code present (${codeHits} signal${codeHits > 1 ? 's' : ''})`); }

  // Multi-step / planning language.
  const multiHits = countMatches(text, MULTISTEP_PATTERNS);
  if (multiHits > 0) { score += 2; reasons.push(`multi-step task (${multiHits} signal${multiHits > 1 ? 's' : ''})`); }

  // Deep reasoning language.
  const reasonHits = countMatches(text, REASONING_PATTERNS);
  if (reasonHits > 0) { score += 2; reasons.push(`reasoning requested (${reasonHits} signal${reasonHits > 1 ? 's' : ''})`); }

  // Structured output asks for more careful generation.
  const structHits = countMatches(text, STRUCTURED_PATTERNS);
  if (structHits > 0) { score += 1; reasons.push('structured output requested'); }

  // Questions with multiple sub-questions ("and" chains) are usually harder.
  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks >= 3) { score += 1; reasons.push(`${questionMarks} questions in one prompt`); }

  const tier = score >= FLAGSHIP_THRESHOLD ? 'flagship' : 'economy';
  const model = tier === 'flagship' ? FLAGSHIP_MODEL : ECONOMY_MODEL;
  if (reasons.length === 0) reasons.push('simple, short prompt');

  return { tier, model, score, threshold: FLAGSHIP_THRESHOLD, reasons };
}

module.exports = { classify, ECONOMY_MODEL, FLAGSHIP_MODEL, FLAGSHIP_THRESHOLD };
