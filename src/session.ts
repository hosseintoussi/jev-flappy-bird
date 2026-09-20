// The Jev decision loop and everything recorded about it.
// There is no local policy. If Jev does not answer, nothing flaps.

import type { Game, Observation } from "./game";
import { FLAP_QUESTION } from "./question";

// Public pricing, https://docs.typesafe.ai/models (Jev 1.13): $0.042 per million
// input tokens, output tokens free. Used only for the clearly-labeled cost estimate.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
// Normally about round trip / interval requests are in flight. The cap only matters when the
// API stalls, so that unanswered requests don't pile up.
const MAX_IN_FLIGHT = 12;

export type Action = "FLAP" | "WAIT";

export interface Decision {
  n: number;
  timestamp: string;
  t: number; // performance.now() when the response arrived
  attempt: number;
  state: Observation;
  leadMs: number; // how far ahead of "now" the state was measured (0 = latency lead off)
  inFlight: number; // requests awaiting an answer when this one was sent, itself included
  action: Action;
  probabilities: Record<string, number>;
  pFlap: number;
  confidence: number;
  jevMs: number | null; // Jev's own time, as measured by TypeSafe's gateway (null if not reported)
  apiMs: number; // measured on our server around the SDK call: jevMs plus the network to the API
  roundTripMs: number; // browser -> local server -> Jev -> back
  heldMs: number; // how long an early answer waited for the moment its state described
  inputTokens: number;
  outputTokens: number;
  model: string;
  requestId?: string;
  score: number;
  applied: boolean; // false if the bird had died, or the answer was superseded, when it arrived
  // A flap landed after this state was measured. The state described the bird left alone, so the
  // answer is about a moment that never happened. WAITs change nothing and supersede nothing.
  superseded: boolean;
  diedAfterMs: number | null; // filled in when this attempt ends
}

export interface ApiError {
  timestamp: string;
  kind: string;
  status?: number;
  message: string;
  latencyMs: number;
}

export interface Settings {
  intervalMs: number;
  words: boolean;
  lead: boolean; // measure the state at the moment the decision will land, not when it is asked
}

export class Session {
  settings: Settings = { intervalMs: 50, words: true, lead: true };
  roundTripEma = 280; // ms, running estimate of how stale a decision is when it lands

  startedAt = performance.now();
  startedIso = new Date().toISOString();
  decisions: Decision[] = [];
  errors: ApiError[] = [];
  flaps = 0;
  waits = 0;
  superseded = 0;
  inFlight = 0;
  apiSum = 0;
  jevSum = 0;
  jevCount = 0;
  roundTripSum = 0;
  inputTokens = 0;
  outputTokens = 0;
  attempt = 1;
  deaths = 0;
  best = 0;
  score = 0;
  offline = false;
  lastError: ApiError | null = null;
  model = "";

  private listeners = new Set<() => void>();
  private playedBase = 0; // game.playedMs when the current stats began
  private version = 0;
  private gen = 0; // bumping this retires the running loop
  private flapEpoch = 0; // flaps applied so far; an answer is only good for the epoch it was asked in
  private holdUntil = 0; // no requests before this time (set after an error)
  // Answers come back on one event stream, not on the request that asked (see server/jev.ts).
  private client = crypto.randomUUID();
  private stream: EventSource | undefined;
  private nextRid = 0;
  private waiting = new Map<number, (answer: { status: number; body: any }) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private game: Game) {
    game.events = {
      onScore: (score) => {
        this.score = score;
        this.best = Math.max(this.best, score);
        this.emit();
      },
      onDeath: () => {
        this.deaths += 1;
        const now = performance.now();
        for (let i = this.decisions.length - 1; i >= 0 && this.decisions[i].attempt === this.attempt; i--) {
          this.decisions[i].diedAfterMs = Math.round(now - this.decisions[i].t);
        }
        this.emit();
      },
      onRestart: () => {
        this.attempt += 1;
        this.score = 0;
        this.emit();
      },
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get total() {
    return this.decisions.length;
  }
  lastFlap: Decision | undefined; // the last flap that was applied
  get last(): Decision | undefined {
    return this.decisions[this.decisions.length - 1];
  }
  get avgJev() {
    return this.jevCount ? this.jevSum / this.jevCount : 0;
  }
  get avgApi() {
    return this.total ? this.apiSum / this.total : 0;
  }
  /** The share of an API call that is distance, not Jev. */
  get avgNetwork() {
    return this.jevCount ? Math.max(0, this.avgApi - this.avgJev) : 0;
  }
  get avgRoundTrip() {
    return this.total ? this.roundTripSum / this.total : 0;
  }
  /** 95th percentile of Jev's own time over the last 200 decisions. */
  get p95Jev() {
    const recent = this.decisions.slice(-200).flatMap((d) => d.jevMs ?? []).sort((a, b) => a - b);
    return recent.length ? recent[Math.min(recent.length - 1, Math.floor(recent.length * 0.95))] : 0;
  }
  /** Time spent actually playing: pauses and hidden-tab time don't count, so rates stay honest. */
  get runtimeMs() {
    return this.game.playedMs - this.playedBase;
  }
  get tokensPerDecision() {
    return this.total ? this.inputTokens / this.total : 0;
  }
  get estCostUsd() {
    return this.inputTokens * USD_PER_INPUT_TOKEN;
  }
  get estCostPerHourUsd() {
    return this.runtimeMs > 5000 ? (this.estCostUsd / this.runtimeMs) * 3_600_000 : 0;
  }
  decisionsPerSecond(windowMs = 3000) {
    const now = performance.now();
    const span = Math.min(windowMs, now - this.startedAt);
    if (span < 250) return 0;
    let count = 0;
    for (let i = this.decisions.length - 1; i >= 0 && now - this.decisions[i].t <= span; i--) count++;
    return count / (span / 1000);
  }

  /** Called when the user starts the first run, so nothing counts time spent on the ready screen. */
  beginRun() {
    this.markStart();
    this.emit();
  }

  private markStart() {
    this.startedAt = performance.now();
    this.playedBase = this.game.playedMs;
    this.startedIso = new Date().toISOString();
  }

  resetStats() {
    this.markStart();
    this.decisions = [];
    this.errors = [];
    this.flaps = this.waits = this.superseded = this.apiSum = this.jevSum = this.jevCount = 0;
    this.roundTripSum = this.inputTokens = this.outputTokens = 0;
    this.attempt = 1;
    this.deaths = 0;
    this.best = this.score;
    this.lastError = null;
    this.lastFlap = undefined;
    this.emit();
  }

  start() {
    this.stream = new EventSource(`/api/decide/stream?client=${this.client}`);
    this.stream.onmessage = (e) => {
      const { rid, ...answer } = JSON.parse(e.data);
      this.waiting.get(rid)?.(answer);
    };
    // The browser reconnects by itself; until it does, say so instead of silently not asking.
    this.stream.onerror = () => {
      if (!this.offline) this.fail("local_server", "lost the answer stream from the local server", 0);
    };
    void this.loop(++this.gen);
  }
  stop() {
    this.gen++;
    clearTimeout(this.timer);
    this.stream?.close();
  }

  /** Posts one question and resolves with its answer from the stream. */
  private async post(state: Observation): Promise<{ status: number; body: any }> {
    const rid = ++this.nextRid;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<{ status: number; body: any }>((resolve, reject) => {
      this.waiting.set(rid, resolve);
      // A lost answer must surface as JEV OFFLINE, never as a silent freeze.
      timeout = setTimeout(() => reject(new Error("no answer within 6s")), 6000);
    });
    answered.catch(() => {}); // only awaited below if the POST is accepted
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: this.client, rid, state }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.status !== 202) return { status: res.status, body: await res.json() };
      return await answered;
    } finally {
      clearTimeout(timeout);
      this.waiting.delete(rid);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => (this.timer = setTimeout(resolve, ms)));
  }

  /** Asks on a fixed clock. It never waits for an earlier answer, so several requests are in flight. */
  private async loop(gen: number) {
    let next = performance.now();
    while (gen === this.gen) {
      this.ask();
      next = Math.max(next + this.settings.intervalMs, performance.now());
      await this.sleep(next - performance.now());
    }
  }

  private ask() {
    const now = performance.now();
    // While offline, probe with one request at a time so an outage doesn't hammer the API.
    if (now < this.holdUntil || this.inFlight >= (this.offline ? 1 : MAX_IN_FLIGHT)) return;
    // A hidden tab gets no animation frames, so the game is frozen: don't spend Jev calls on it.
    if (this.game.paused || document.hidden) return;
    if (this.stream?.readyState === EventSource.CONNECTING && !this.offline) return; // still opening
    const leadMs = this.settings.lead ? Math.round(this.roundTripEma) : 0;
    const state = this.game.observe(this.settings.words, leadMs);
    if (!state) return;
    this.inFlight++;
    void this.decide(state, leadMs, now).then((ok) => {
      this.inFlight--;
      if (!ok) this.holdUntil = performance.now() + 500;
    });
  }

  private async decide(state: Observation, leadMs: number, began: number): Promise<boolean> {
    const attempt = this.attempt;
    const epoch = this.flapEpoch;
    const inFlight = this.inFlight;
    try {
      const { status, body } = await this.post(state);
      if (status !== 200) {
        this.fail(body.error?.kind ?? `http_${status}`, body.error?.message ?? `HTTP ${status}`, body.latencyMs ?? performance.now() - began, body.error?.status);
        return false;
      }

      const action: Action = body.choice === "FLAP" ? "FLAP" : "WAIT";
      const pFlap: number = body.probabilities?.FLAP ?? 0;
      const arrived = performance.now();
      this.roundTripEma += (Math.min(arrived - began, 1000) - this.roundTripEma) * 0.2;
      // The state described the bird leadMs after it was measured. An answer that comes back
      // sooner waits for that moment, so it is applied to the bird it was asked about. A late
      // answer is applied on arrival. The answer itself is never changed.
      const heldMs = Math.max(0, began + leadMs - arrived);
      if (heldMs > 1) await new Promise((resolve) => setTimeout(resolve, heldMs));
      // Apply only if the state still describes this bird: same life, and no flap since it was measured.
      const superseded = epoch !== this.flapEpoch;
      const applied = !superseded && !this.game.dead && !this.game.paused && !document.hidden && attempt === this.attempt;
      if (applied && action === "FLAP") {
        this.game.flap();
        this.flapEpoch++;
      }

      const now = performance.now();
      this.decisions.push({
        n: this.decisions.length + 1,
        timestamp: new Date().toISOString(),
        t: now,
        attempt,
        state,
        leadMs,
        inFlight,
        action,
        probabilities: body.probabilities,
        pFlap,
        confidence: body.confidence,
        jevMs: body.jevMs ?? null,
        apiMs: body.latencyMs,
        roundTripMs: arrived - began,
        heldMs: Math.round(heldMs),
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        model: body.model,
        requestId: body.requestId,
        score: this.game.score,
        applied,
        superseded,
        diedAfterMs: null,
      });
      if (action === "FLAP") this.flaps++;
      else this.waits++;
      if (applied && action === "FLAP") this.lastFlap = this.last;
      if (superseded) this.superseded++;
      this.apiSum += body.latencyMs ?? 0;
      if (body.jevMs != null) {
        this.jevSum += body.jevMs;
        this.jevCount++;
      }
      this.roundTripSum += arrived - began;
      this.inputTokens += body.usage?.input_tokens ?? 0;
      this.outputTokens += body.usage?.output_tokens ?? 0;
      this.model = body.model;
      this.offline = this.game.offline = false;
      this.emit();
      // The flap changed the bird's path, so ask about the new one now rather than at the next tick.
      if (applied && action === "FLAP") this.ask();
      return true;
    } catch (err) {
      this.fail("local_server", err instanceof Error ? err.message : String(err), performance.now() - began);
      return false;
    }
  }

  private fail(kind: string, message: string, latencyMs: number, status?: number) {
    this.lastError = { timestamp: new Date().toISOString(), kind, status, message, latencyMs: Math.round(latencyMs) };
    this.errors.push(this.lastError);
    this.offline = this.game.offline = true;
    this.emit();
  }

  exportJson() {
    return JSON.stringify(
      {
        app: "Jev Plays Flappy Bird",
        exportedAt: new Date().toISOString(),
        sessionStartedAt: this.startedIso,
        runtimeMs: Math.round(this.runtimeMs),
        question: { type: "choice", ...FLAP_QUESTION },
        settings: this.settings,
        summary: {
          decisions: this.total,
          flaps: this.flaps,
          waits: this.waits,
          superseded: this.superseded,
          avgJevMs: Math.round(this.avgJev * 10) / 10,
          p95JevMs: Math.round(this.p95Jev),
          avgNetworkMs: Math.round(this.avgNetwork * 10) / 10,
          avgApiMs: Math.round(this.avgApi * 10) / 10,
          avgRoundTripMs: Math.round(this.avgRoundTrip * 10) / 10,
          attempts: this.attempt,
          deaths: this.deaths,
          bestScore: this.best,
          apiErrors: this.errors.length,
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          inputTokensPerDecision: Math.round(this.tokensPerDecision),
          estimatedCostUsd: this.estCostUsd,
          estimatedCostPerHourUsd: this.estCostPerHourUsd,
          costBasis: "estimate: input_tokens x $0.042/Mtok (docs.typesafe.ai/models); output tokens free",
          model: this.model,
        },
        decisions: this.decisions.map(({ t: _t, ...d }) => d),
        errors: this.errors,
      },
      null,
      2,
    );
  }
}
