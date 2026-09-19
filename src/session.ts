// The Jev decision loop and everything recorded about it.
// Flow: observe game -> POST /api/decide -> Jev's Choice (FLAP | WAIT) -> game.flap() at most once.
// There is no local policy. If Jev does not answer, nothing flaps.

import type { Game, Observation } from "./game";
import { FLAP_QUESTION } from "./question";

// Public pricing, https://docs.typesafe.ai/models (Jev 1.13): $0.042 per million
// input tokens, output tokens free. Used only for the clearly-labeled cost estimate.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export type Action = "FLAP" | "WAIT";

export interface Decision {
  n: number;
  timestamp: string;
  t: number; // performance.now() when the response arrived
  attempt: number;
  state: Observation;
  leadMs: number; // how far ahead of "now" the state was measured (0 = latency lead off)
  action: Action;
  probabilities: Record<string, number>; // Jev's probability per option
  pFlap: number; // probabilities.FLAP
  confidence: number; // Jev's own confidence in the chosen option
  jevLatencyMs: number; // measured on our server around the SDK call
  roundTripMs: number; // browser -> local server -> Jev -> back
  inputTokens: number;
  outputTokens: number;
  model: string;
  requestId?: string;
  score: number;
  applied: boolean; // false if the bird had already died when the answer arrived
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
  settings: Settings = { intervalMs: 100, words: true, lead: true };
  roundTripEma = 280; // ms, running estimate of how stale a decision is when it lands

  startedAt = performance.now();
  private playedBase = 0;
  startedIso = new Date().toISOString();
  decisions: Decision[] = [];
  errors: ApiError[] = [];
  flaps = 0;
  waits = 0;
  latencySum = 0;
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
  private version = 0;
  private gen = 0; // bumping this retires any loop still awaiting a response
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

  // ------------------------------------------------------------ store api

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
  get last(): Decision | undefined {
    return this.decisions[this.decisions.length - 1];
  }
  get avgLatency() {
    return this.total ? this.latencySum / this.total : 0;
  }
  get avgRoundTrip() {
    return this.total ? this.roundTripSum / this.total : 0;
  }
  /** 95th percentile of Jev latency over the last 200 decisions. */
  get p95Latency() {
    const recent = this.decisions.slice(-200).map((d) => d.jevLatencyMs).sort((a, b) => a - b);
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
  /** Spend rate so far, scaled to an hour of play. */
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

  /** Called when the user starts the first run, so runtime doesn't count time spent on the ready screen. */
  beginRun() {
    this.startedAt = performance.now();
    this.playedBase = this.game.playedMs;
    this.startedIso = new Date().toISOString();
    this.emit();
  }

  resetStats() {
    this.startedAt = performance.now();
    this.playedBase = this.game.playedMs;
    this.startedIso = new Date().toISOString();
    this.decisions = [];
    this.errors = [];
    this.flaps = this.waits = this.latencySum = this.roundTripSum = this.inputTokens = this.outputTokens = 0;
    this.attempt = 1;
    this.deaths = 0;
    this.best = this.score;
    this.lastError = null;
    this.emit();
  }

  // -------------------------------------------------------- decision loop

  start() {
    void this.loop(++this.gen);
  }
  stop() {
    this.gen++;
    clearTimeout(this.timer);
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => (this.timer = setTimeout(resolve, ms)));
  }

  /** One request in flight at a time; starts are spaced at least intervalMs apart. */
  private async loop(gen: number) {
    while (gen === this.gen) {
      const began = performance.now();
      let ok = false;
      try {
        // A hidden tab gets no animation frames, so the game is frozen: don't spend Jev calls on it.
        const leadMs = this.settings.lead ? Math.round(this.roundTripEma) : 0;
        const state = this.game.paused || document.hidden ? null : this.game.observe(this.settings.words, leadMs);
        if (!state) {
          await this.sleep(30);
          continue;
        }
        ok = await this.decide(state, leadMs, began);
      } catch (err) {
        this.fail("client", err instanceof Error ? err.message : String(err), performance.now() - began);
      }
      const spent = performance.now() - began;
      // After an error, slow down a little so an outage doesn't hammer the API.
      await this.sleep(Math.max(0, (ok ? this.settings.intervalMs : Math.max(500, this.settings.intervalMs)) - spent));
    }
  }

  private async decide(state: Observation, leadMs: number, began: number): Promise<boolean> {
    const attempt = this.attempt;
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
        // A hung request must surface as JEV OFFLINE, never as a silent freeze.
        signal: AbortSignal.timeout(6000),
      });
      const body = await res.json();
      if (!res.ok) {
        this.fail(body.error?.kind ?? `http_${res.status}`, body.error?.message ?? res.statusText, body.latencyMs ?? performance.now() - began, body.error?.status);
        return false;
      }

      // Jev's own choice, used as returned. No threshold, no post-processing.
      const action: Action = body.choice === "FLAP" ? "FLAP" : "WAIT";
      const pFlap: number = body.probabilities?.FLAP ?? 0;
      // Apply only if this is still the same life the state was observed in.
      const applied = !this.game.dead && !this.game.paused && attempt === this.attempt;
      if (applied && action === "FLAP") this.game.flap(); // exactly one impulse per FLAP response

      const now = performance.now();
      this.roundTripEma += (Math.min(now - began, 1000) - this.roundTripEma) * 0.2;
      this.decisions.push({
        n: this.decisions.length + 1,
        timestamp: new Date().toISOString(),
        t: now,
        attempt,
        state,
        leadMs,
        action,
        probabilities: body.probabilities,
        pFlap,
        confidence: body.confidence,
        jevLatencyMs: body.latencyMs,
        roundTripMs: now - began,
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        model: body.model,
        requestId: body.requestId,
        score: this.game.score,
        applied,
        diedAfterMs: null,
      });
      if (action === "FLAP") this.flaps++;
      else this.waits++;
      this.latencySum += body.latencyMs ?? 0;
      this.roundTripSum += now - began;
      this.inputTokens += body.usage?.input_tokens ?? 0;
      this.outputTokens += body.usage?.output_tokens ?? 0;
      this.model = body.model;
      this.offline = this.game.offline = false;
      this.emit();
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

  // --------------------------------------------------------------- export

  exportJson() {
    return JSON.stringify(
      {
        app: "Jev Plays Flappy Bird",
        exportedAt: new Date().toISOString(),
        sessionStartedAt: this.startedIso,
        runtimeMs: Math.round(this.runtimeMs), // time actually playing; pauses excluded
        question: { type: "choice", ...FLAP_QUESTION },
        settings: this.settings,
        summary: {
          decisions: this.total,
          flaps: this.flaps,
          waits: this.waits,
          avgJevLatencyMs: Math.round(this.avgLatency * 10) / 10,
          p95JevLatencyMs: Math.round(this.p95Latency),
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
