// src/markov.js
//
// Two-level Markov engine:
//   1. Topic chain   — picks the next persona topic from the weighted
//                      transition table in the persona graph.
//   2. Query chain   — a word-level bigram model trained on the topic's query
//                      corpus. It splices corpus queries at shared words to
//                      produce plausible novel queries, so the same handful of
//                      strings is not replayed verbatim (which is trivially
//                      fingerprintable).
//
// Everything here is pure and takes an injectable `rng` so it can be unit
// tested deterministically under Node.

const START = "\u0002";
const END = "\u0003";

export const SEARCH_ENGINES = {
  google: {
    label: "Google",
    hosts: ["google.com"],
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`
  },
  bing: {
    label: "Bing",
    hosts: ["bing.com", "microsoft.com", "msn.com"],
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`
  },
  duckduckgo: {
    label: "DuckDuckGo",
    hosts: ["duckduckgo.com"],
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  }
};

/** Deterministic PRNG (mulberry32) for tests / reproducible runs. */
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(list, rng = Math.random) {
  if (!list || list.length === 0) return undefined;
  return list[Math.floor(rng() * list.length)];
}

/** Weighted choice over a `{ key: weight }` map. Non-positive weights are skipped. */
export function weightedChoice(weights, rng = Math.random) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return undefined;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r < 0) return key;
  }
  return entries[entries.length - 1][0];
}

/** Topic-level transition: returns the next topic key. */
export function nextTopic(graph, current, rng = Math.random) {
  const topics = Object.keys(graph.topics);
  if (!current || !graph.topics[current]) return pick(topics, rng);

  const row = graph.transitions?.[current];
  if (!row) return pick(topics, rng);

  const weights = {};
  for (const t of topics) weights[t] = row[t] ?? 0;
  return weightedChoice(weights, rng) ?? pick(topics, rng);
}

/** Build a bigram model: word -> list of successor words (with multiplicity). */
export function buildBigramModel(corpus) {
  const model = new Map();
  const add = (from, to) => {
    if (!model.has(from)) model.set(from, []);
    model.get(from).push(to);
  };
  for (const query of corpus) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    add(START, words[0]);
    for (let i = 0; i < words.length - 1; i++) add(words[i], words[i + 1]);
    add(words[words.length - 1], END);
  }
  return model;
}

/** Random walk over a bigram model. Returns an array of words. */
export function walkBigram(model, rng = Math.random, maxWords = 10) {
  const out = [];
  let current = START;
  while (out.length < maxWords) {
    const next = pick(model.get(current), rng);
    if (next === undefined || next === END) break;
    out.push(next);
    current = next;
  }
  return out;
}

/**
 * Generate a search query for a topic.
 * With probability `originalBias` returns a corpus query verbatim; otherwise
 * tries a bigram walk and accepts it if it is between minWords and maxWords.
 */
export function generateQuery(corpus, rng = Math.random, opts = {}) {
  const { originalBias = 0.35, minWords = 3, maxWords = 10, attempts = 8 } = opts;
  if (!corpus || corpus.length === 0) return undefined;
  if (rng() < originalBias) return pick(corpus, rng);

  const model = buildBigramModel(corpus);
  for (let i = 0; i < attempts; i++) {
    const words = walkBigram(model, rng, maxWords + 1);
    if (words.length >= minWords && words.length <= maxWords) return words.join(" ");
  }
  return pick(corpus, rng);
}

/**
 * Plan the next synthetic browsing step.
 *
 * @returns {{
 *   topic: string, kind: "search"|"visit", url: string, query?: string,
 *   domain?: string, depth: number, linkMode: "external"|"same-site",
 *   preferredHosts: string[], excludeHosts: string[], productPatterns: string[]
 * }}
 */
export function planStep(graph, currentTopic, opts = {}, rng = Math.random) {
  const { searchEngine = "google", searchProbability = 0.55, maxDepth = 2 } = opts;
  const topic = nextTopic(graph, currentTopic, rng);
  const node = graph.topics[topic];
  const productPatterns = graph.productLinkPatterns ?? [];
  const engine = SEARCH_ENGINES[searchEngine] ?? SEARCH_ENGINES.google;

  if (rng() < searchProbability) {
    const query = generateQuery(node.queries, rng);
    return {
      topic,
      kind: "search",
      query,
      url: engine.url(query),
      // From a results page, always click through to at least one result.
      depth: 1 + Math.floor(rng() * Math.max(1, maxDepth)),
      linkMode: "external",
      preferredHosts: [...node.seed_domains],
      excludeHosts: [...engine.hosts],
      productPatterns
    };
  }

  const domain = pick(node.seed_domains, rng);
  return {
    topic,
    kind: "visit",
    domain,
    url: `https://www.${domain}/`,
    depth: Math.floor(rng() * (maxDepth + 1)),
    linkMode: "same-site",
    preferredHosts: [domain],
    excludeHosts: [],
    productPatterns
  };
}
