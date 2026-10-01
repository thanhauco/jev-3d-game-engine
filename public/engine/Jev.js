/**
 * Jev integration for the engine.
 *
 * Jev (TypeSafe AI, Sept 2026) is a "System One" model: you send a `state`
 * plus typed `questions` and get typed answers back, no prose:
 *   - Choice: pick one option from `criteria` (map of id -> description)
 *   - Score:  rate against ordered levels (`criteria` is an array)
 *   - Noul:   probability that a yes/no statement is true
 *
 * All questions in one request are answered in a single pass, so the brain
 * system batches every agent's questions into one call per decision tick.
 *
 * Each question builder takes an optional `mock(state)` heuristic. It is kept
 * under a Symbol so it is never serialized; it's used only when the server has
 * no API key (or the request fails), so the game runs without Jev access.
 */

const MOCK = Symbol("mock");

export function Choice(instructions, criteria, mock) {
  return { type: "choice", instructions, criteria, [MOCK]: mock };
}

export function Score(instructions, levels, mock) {
  return { type: "score", instructions, criteria: levels, [MOCK]: mock };
}

export function Noul(instructions, mock, criteria) {
  const q = { type: "noul", instructions, [MOCK]: mock };
  if (criteria) q.criteria = criteria; // { true: "...", false: "..." }
  return q;
}

// ---------------------------------------------------------------------------

const softmax = (logits, temp = 1) => {
  const m = Math.max(...logits);
  const ex = logits.map((l) => Math.exp((l - m) / temp));
  const s = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / s);
};
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const argmax = (a) => a.reduce((best, v, i) => (v > a[best] ? i : best), 0);

/** Local stand-in that returns the same answer shapes as the real API. */
function mockAnswer(q, state) {
  const h = q[MOCK];
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    const raw = h?.(state) ?? {};
    const probs = softmax(keys.map((k) => (raw[k] ?? 0) + Math.random() * 0.15), 0.6);
    const i = argmax(probs);
    return {
      type: "choice",
      choice: keys[i],
      probabilities: Object.fromEntries(keys.map((k, j) => [k, +probs[j].toFixed(3)])),
      confidence: +probs[i].toFixed(3),
    };
  }
  if (q.type === "score") {
    const levels = q.criteria;
    // Heuristic returns a target level (float); spread probability around it.
    const target = h?.(state) ?? (levels.length - 1) / 2;
    const probs = softmax(levels.map((_, i) => -((i - target) ** 2)), 0.8);
    const i = argmax(probs);
    return {
      type: "score",
      score: i,
      legend: Object.fromEntries(levels.map((l, j) => [j, l])),
      probabilities: Object.fromEntries(levels.map((_, j) => [j, +probs[j].toFixed(3)])),
      confidence: +probs[i].toFixed(3),
    };
  }
  // noul: heuristic returns a logit
  const p = sigmoid((h?.(state) ?? 0) + (Math.random() - 0.5) * 0.2);
  return { type: "noul", noul: +p.toFixed(3) };
}

/** Fill in fields the game relies on so live and mock answers look identical. */
function normalize(a) {
  if (!a) return a;
  if (a.type === "noul" && a.confidence === undefined) a.confidence = Math.max(a.noul, 1 - a.noul);
  return a;
}

export class JevClient {
  constructor({ endpoint = "/api/jev", model = "jev-latest" } = {}) {
    this.endpoint = endpoint;
    this.model = model;
    this.live = false;
    this.lastError = null;
  }

  async init() {
    try {
      const r = await fetch(`${this.endpoint}/status`);
      const s = await r.json();
      this.live = Boolean(s.live);
      if (s.live) this.model = s.model;
    } catch {
      this.live = false;
    }
    return this;
  }

  /**
   * @param {object} state      anything JSON-serializable (Jev accepts string | object | array)
   * @param {Record<string, object>} questions  built with Choice / Score / Noul
   * @returns {Promise<{answers: Record<string, any>, latencyMs: number, source: "jev"|"mock", usage?: object}>}
   */
  async ask(state, questions) {
    const t0 = performance.now();
    if (this.live) {
      try {
        const r = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, state, questions }),
        });
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        const data = await r.json();
        const answers = data.answers ?? data; // tolerate both documented shapes
        for (const k in answers) normalize(answers[k]);
        this.lastError = null;
        return { answers, latencyMs: performance.now() - t0, source: "jev", usage: data.usage };
      } catch (err) {
        this.lastError = String(err.message ?? err);
        // fall through to mock so gameplay never stalls
      }
    }
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 90)); // mimic Jev's ~70-500ms
    const answers = {};
    for (const [id, q] of Object.entries(questions)) answers[id] = normalize(mockAnswer(q, state));
    return { answers, latencyMs: performance.now() - t0, source: "mock" };
  }
}

// ---------------------------------------------------------------------------

/**
 * Engine system that schedules Jev decisions for every entity with a `brain`.
 *
 * brain component shape:
 *   {
 *     id: "g1",
 *     questions(sharedState) -> { key: Choice|Score|Noul, ... },
 *     apply(answers, meta)   -> void   // answers keyed by the same keys
 *   }
 *
 * The model only chooses; the engine executes and verifies. Decisions are
 * requested at an adaptive rate (~3x rolling p95 latency, clamped), and only
 * one request is in flight at a time so stale state never piles up.
 */
export class JevBrainSystem {
  constructor(client, { stateFn, minInterval = 0.5, maxInterval = 3, onDecision } = {}) {
    this.client = client;
    this.stateFn = stateFn;
    this.minInterval = minInterval;
    this.maxInterval = maxInterval;
    this.onDecision = onDecision;
    this.inFlight = false;
    this.cooldown = 0;
    this.latencies = [];
    this.calls = 0;
    this.inputTokens = 0;
  }

  get p95() {
    if (!this.latencies.length) return 0;
    const s = [...this.latencies].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  }

  get interval() {
    const target = (3 * this.p95) / 1000;
    return Math.min(this.maxInterval, Math.max(this.minInterval, target));
  }

  update(dt, engine) {
    this.cooldown -= dt;
    if (this.inFlight || this.cooldown > 0) return;
    const agents = engine.query("brain").filter((e) => e.alive !== false);
    if (!agents.length) return;

    const state = this.stateFn(engine);
    const questions = {};
    for (const a of agents) {
      for (const [k, q] of Object.entries(a.brain.questions(state))) questions[`${a.brain.id}__${k}`] = q;
    }

    this.inFlight = true;
    this.client
      .ask(state, questions)
      .then((res) => {
        this.calls++;
        this.latencies.push(res.latencyMs);
        if (this.latencies.length > 40) this.latencies.shift();
        this.inputTokens += res.usage?.input_tokens ?? 0;

        for (const a of agents) {
          if (a.alive === false) continue;
          const prefix = `${a.brain.id}__`;
          const mine = {};
          for (const [k, v] of Object.entries(res.answers)) if (k.startsWith(prefix)) mine[k.slice(prefix.length)] = v;
          a.brain.apply(mine, res);
        }
        this.onDecision?.(res, this);
      })
      .finally(() => {
        this.inFlight = false;
        this.cooldown = this.interval;
      });
  }
}
