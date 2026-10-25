import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRng, weightedChoice, nextTopic, buildBigramModel, walkBigram,
  generateQuery, planStep, SEARCH_ENGINES
} from "../src/markov.js";
import { FEMALE_PERSONA_GRAPH, getPersona, DEFAULT_PERSONA_ID } from "../src/persona.js";

test("createRng is deterministic and in [0,1)", () => {
  const a = createRng(42), b = createRng(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("weightedChoice respects weights and skips zero weights", () => {
  const rng = createRng(1);
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 20000; i++) counts[weightedChoice({ a: 1, b: 3, c: 0 }, rng)]++;
  assert.equal(counts.c, 0);
  const ratio = counts.b / counts.a;
  assert.ok(ratio > 2.7 && ratio < 3.3, `ratio ${ratio}`);
  assert.equal(weightedChoice({ x: 0 }, rng), undefined);
});

test("nextTopic only follows non-zero transitions", () => {
  const rng = createRng(7);
  const row = FEMALE_PERSONA_GRAPH.transitions.skincare;
  for (let i = 0; i < 2000; i++) {
    const t = nextTopic(FEMALE_PERSONA_GRAPH, "skincare", rng);
    assert.ok(row[t] > 0, `unexpected transition skincare -> ${t}`);
  }
});

test("nextTopic picks a valid topic from a cold start", () => {
  const rng = createRng(3);
  const topics = Object.keys(FEMALE_PERSONA_GRAPH.topics);
  for (let i = 0; i < 100; i++) assert.ok(topics.includes(nextTopic(FEMALE_PERSONA_GRAPH, null, rng)));
});

test("persona transitions reference only defined topics", () => {
  const topics = new Set(Object.keys(FEMALE_PERSONA_GRAPH.topics));
  for (const [from, row] of Object.entries(FEMALE_PERSONA_GRAPH.transitions)) {
    assert.ok(topics.has(from), from);
    for (const to of Object.keys(row)) assert.ok(topics.has(to), `${from} -> ${to}`);
  }
});

test("getPersona falls back to default", () => {
  assert.equal(getPersona("nope").id, DEFAULT_PERSONA_ID);
});

test("bigram walk only emits observed transitions", () => {
  const corpus = FEMALE_PERSONA_GRAPH.topics.skincare.queries;
  const model = buildBigramModel(corpus);
  const pairs = new Set();
  for (const q of corpus) {
    const w = q.toLowerCase().split(/\s+/);
    for (let i = 0; i < w.length - 1; i++) pairs.add(`${w[i]} ${w[i + 1]}`);
  }
  const rng = createRng(11);
  for (let i = 0; i < 500; i++) {
    const words = walkBigram(model, rng, 12);
    for (let j = 0; j < words.length - 1; j++) assert.ok(pairs.has(`${words[j]} ${words[j + 1]}`));
  }
});

test("generateQuery respects word bounds and produces some novel queries", () => {
  const corpus = FEMALE_PERSONA_GRAPH.topics.skincare.queries;
  const rng = createRng(5);
  const lower = new Set(corpus.map((q) => q.toLowerCase()));
  let novel = 0;
  for (let i = 0; i < 500; i++) {
    const q = generateQuery(corpus, rng);
    assert.ok(typeof q === "string" && q.length > 0);
    if (!lower.has(q.toLowerCase())) {
      novel++;
      const n = q.split(" ").length;
      assert.ok(n >= 3 && n <= 10, `bad length: ${q}`);
    }
  }
  assert.ok(novel > 50, `only ${novel} novel queries`);
});

test("planStep produces well-formed search and visit plans", () => {
  const rng = createRng(9);
  const kinds = new Set();
  for (let i = 0; i < 300; i++) {
    const plan = planStep(FEMALE_PERSONA_GRAPH, null, { searchEngine: "bing", maxDepth: 2 }, rng);
    kinds.add(plan.kind);
    assert.ok(new URL(plan.url).protocol === "https:");
    assert.ok(plan.depth >= 0 && plan.depth <= 2);
    if (plan.kind === "search") {
      assert.ok(plan.url.startsWith("https://www.bing.com/search?q="));
      assert.equal(plan.linkMode, "external");
      assert.ok(plan.depth >= 1);
      assert.deepEqual(plan.excludeHosts, SEARCH_ENGINES.bing.hosts);
    } else {
      assert.equal(plan.linkMode, "same-site");
      assert.ok(FEMALE_PERSONA_GRAPH.topics[plan.topic].seed_domains.includes(plan.domain));
    }
  }
  assert.deepEqual([...kinds].sort(), ["search", "visit"]);
});
