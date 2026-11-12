// In-memory semantic cache.
//
// How it works (no external service, fully offline):
//  1. Exact hit: the normalized prompt string matches a cached prompt exactly.
//  2. Semantic hit: otherwise the prompt is compared against every cached
//     prompt with TF-IDF cosine similarity. If the best score is at or above
//     the threshold (default 0.60), the cached response is reused.
//
// TF-IDF here is the real thing, just small: term frequency per prompt,
// inverse document frequency computed over the cached prompts, and cosine
// similarity between the resulting vectors. Common stopwords are dropped so
// similarity reflects content words, not filler.
//
// Exact and semantic hits are tracked separately so /stats can report them
// independently.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'what', 'whats', 'how', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her', 'our', 'their',
  'at', 'by', 'from', 'as', 'into', 'about', 'please', 'me', 'tell', 'give', 'show',
]);

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Light suffix-stripping stemmer: collapses plurals and common inflections
// ("methods" -> "method", "operations" -> "operation", "explaining" ->
// "explain") so near-duplicate prompts match even when the wording shifts
// a little. Deliberately conservative — it only strips well-known suffixes.
function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => t.length > 1);
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

class SemanticCache {
  constructor({ threshold = 0.60, maxEntries = 500 } = {}) {
    this.threshold = threshold;
    this.maxEntries = maxEntries;
    this.entries = []; // { key, prompt, tokens, tf, response, model, createdAt }
    this.exactHits = 0;
    this.semanticHits = 0;
    this.misses = 0;
  }

  // IDF for a term across the cached prompts (+ the query, so unseen terms
  // still get a finite weight instead of Infinity).
  idf(term, queryTokens) {
    let df = 0;
    for (const e of this.entries) if (e.tf.has(term)) df += 1;
    if (queryTokens.includes(term)) df += 1;
    const n = this.entries.length + 1;
    return Math.log((n + 1) / (df + 1)) + 1;
  }

  // Cosine similarity between the query and one cached entry, using
  // TF-IDF weights computed over the current cache.
  similarity(queryTf, queryTokens, entry) {
    let dot = 0;
    let qNorm = 0;
    let eNorm = 0;
    const terms = new Set([...queryTf.keys(), ...entry.tf.keys()]);
    for (const term of terms) {
      const w = this.idf(term, queryTokens);
      const q = (queryTf.get(term) || 0) * w;
      const e = (entry.tf.get(term) || 0) * w;
      dot += q * e;
      qNorm += q * q;
      eNorm += e * e;
    }
    if (qNorm === 0 || eNorm === 0) return 0;
    return dot / (Math.sqrt(qNorm) * Math.sqrt(eNorm));
  }

  lookup(prompt) {
    const key = normalize(prompt);

    // 1. Exact match.
    for (const e of this.entries) {
      if (e.key === key) {
        this.exactHits += 1;
        return { hit: true, type: 'exact', similarity: 1, response: e.response, model: e.model };
      }
    }

    // 2. Semantic match via TF-IDF cosine similarity.
    const tokens = tokenize(prompt);
    if (tokens.length === 0 || this.entries.length === 0) {
      this.misses += 1;
      return { hit: false, type: 'miss', similarity: 0 };
    }
    const queryTf = termFreq(tokens);
    let best = null;
    let bestScore = 0;
    for (const e of this.entries) {
      const score = this.similarity(queryTf, tokens, e);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best && bestScore >= this.threshold) {
      this.semanticHits += 1;
      return { hit: true, type: 'semantic', similarity: bestScore, response: best.response, model: best.model };
    }

    this.misses += 1;
    return { hit: false, type: 'miss', similarity: bestScore };
  }

  store(prompt, response, model) {
    const key = normalize(prompt);
    // Replace if the same prompt is already cached (keeps the cache fresh).
    const idx = this.entries.findIndex((e) => e.key === key);
    const tokens = tokenize(prompt);
    const entry = { key, prompt, tokens, tf: termFreq(tokens), response, model, createdAt: new Date().toISOString() };
    if (idx >= 0) this.entries[idx] = entry;
    else this.entries.push(entry);
    // FIFO eviction once the cache is full.
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }

  stats() {
    return {
      entries: this.entries.length,
      exactHits: this.exactHits,
      semanticHits: this.semanticHits,
      misses: this.misses,
    };
  }
}

module.exports = { SemanticCache, normalize, tokenize };
