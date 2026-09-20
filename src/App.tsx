import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Game, H, W } from "./game";
import { Session, type Decision } from "./session";

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtMs = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}ms`);
// Decisions arrive every ~50ms. A flap stays on the big readout this long so it can be seen.
const FLAP_HOLD_MS = 220;
const fmtPct = (p: number) => `${Math.round(p * 100)}%`;
const chosenP = (d: Decision) => d.probabilities?.[d.action] ?? (d.action === "FLAP" ? d.pFlap : 1 - d.pFlap);
// Cost is tiny per decision, so keep enough digits to watch it move.
const fmtUsd = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 4)}`;

function fmtRuntime(ms: number) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

export default function App() {
  const game = useMemo(() => new Game(), []);
  const session = useMemo(() => new Session(game), [game]);
  useSyncExternalStore(session.subscribe, session.getVersion);

  const [showTelemetry, setShowTelemetry] = useState(true);
  const [showStream, setShowStream] = useState(true);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  // Decision loop + a slow tick so runtime / decisions-per-second stay live.
  useEffect(() => {
    session.start();
    const tick = setInterval(() => session.emit(), 500);
    return () => {
      session.stop();
      clearInterval(tick);
    };
  }, [session]);

  const togglePause = () => {
    if (!game.started) {
      game.started = true;
      session.beginRun();
    }
    game.paused = !game.paused;
    rerender();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement).tagName === "INPUT") return;
      e.preventDefault();
      if (e.repeat) return; // holding the key must not flicker pause on and off
      togglePause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game, session]);

  const restart = () => {
    game.reset();
    session.attempt += 1;
    session.score = 0;
    session.emit();
  };

  const exportSession = () => {
    const url = URL.createObjectURL(new Blob([session.exportJson()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `jev-flappy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const last = session.last;
  const flap = session.lastFlap;
  const shown = flap && performance.now() - flap.t < FLAP_HOLD_MS ? flap : last;

  return (
    <div className="page">
      <main className="stage">
        <GameCanvas game={game} />

        <aside className="panel">
          <header className={`status ${session.offline ? "is-offline" : ""}`}>
            <span className="dot" />
            <span className="status-title">
              {session.offline ? "JEV OFFLINE" : !game.started ? "JEV IS READY" : game.paused ? "PAUSED" : "JEV IS PLAYING"}
            </span>
            <span className="status-sub">
              {session.offline
                ? (session.lastError?.kind ?? "error")
                : !game.started ? "press space to start" : "flappy bird · live"}
            </span>
          </header>
          {session.offline && session.lastError && (
            <div className="error-line">{session.lastError.message} — no fallback player; the bird gets no input.</div>
          )}

          <Hero last={shown} offline={session.offline} />

          {showTelemetry && (
            <>
              <StatGroup label="Latency">
                <Stat label="Decisions / sec" value={session.decisionsPerSecond().toFixed(1)} strong />
                <Stat label="Jev, avg" value={session.jevCount ? fmtMs(session.avgJev) : "—"} strong />
                <Stat label="In flight" value={String(session.inFlight)} />
                <Stat label="Jev, p95" value={session.jevCount ? fmtMs(session.p95Jev) : "—"} />
                <Stat label="Round trip, avg" value={session.total ? fmtMs(session.avgRoundTrip) : "—"} />
                <Stat label="Network, avg" value={session.jevCount ? fmtMs(session.avgNetwork) : "—"} />
                <Stat label="Superseded" value={fmtInt(session.superseded)} />
                <Stat label="API errors" value={fmtInt(session.errors.length)} bad={session.errors.length > 0} />
              </StatGroup>
              <StatGroup label={`Tokens & cost${session.model ? ` · ${session.model}` : ""}`}>
                <Stat label="Tokens in" value={fmtInt(session.inputTokens)} strong />
                <Stat label="Est. cost" value={fmtUsd(session.estCostUsd)} strong />
                <Stat label="Tokens out (free)" value={fmtInt(session.outputTokens)} />
                <Stat label="Est. cost / hour" value={session.estCostPerHourUsd ? fmtUsd(session.estCostPerHourUsd) : "—"} />
                <Stat label="Tokens in / decision" value={session.total ? fmtInt(session.tokensPerDecision) : "—"} />
                <Stat label="Decisions" value={fmtInt(session.total)} />
              </StatGroup>
              <StatGroup label="Game">
                <Stat label="Score" value={String(session.score)} />
                <Stat label="Best score" value={String(session.best)} />
                <Stat label="Speed" value={`${game.pace.toFixed(2)}×`} />
                <Stat label="Deaths" value={fmtInt(session.deaths)} />
                <Stat label="Flap / wait" value={`${fmtInt(session.flaps)} / ${fmtInt(session.waits)}`} />
                <Stat label="Play time" value={fmtRuntime(session.runtimeMs)} />
              </StatGroup>
            </>
          )}

          {showStream && <Stream decisions={session.decisions} />}
        </aside>
      </main>

      <details className="debug">
        <summary>debug</summary>
        <div className="debug-body">
          <label>
            <span>Decision interval · {session.settings.intervalMs}ms</span>
            <input
              type="range" min={30} max={1000} step={10}
              value={session.settings.intervalMs}
              onChange={(e) => { session.settings.intervalMs = Number(e.target.value); rerender(); }}
            />
          </label>
          <label>
            <span>Game speed · {game.speed.toFixed(2)}×</span>
            <input
              type="range" min={0.25} max={2} step={0.05}
              value={game.speed}
              onChange={(e) => { game.speed = Number(e.target.value); rerender(); }}
            />
          </label>
          <div className="debug-row">
            <button onClick={togglePause}>{!game.started ? "Start" : game.paused ? "Resume" : "Pause"} <kbd>space</kbd></button>
            <button onClick={restart}>Restart</button>
            <button onClick={() => session.resetStats()}>Reset stats</button>
            <button onClick={exportSession}>Export JSON</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={showTelemetry} onChange={(e) => setShowTelemetry(e.target.checked)} />
            Telemetry
          </label>
          <label className="check">
            <input type="checkbox" checked={showStream} onChange={(e) => setShowStream(e.target.checked)} />
            Decision stream
          </label>
          <label className="check" title="Over the first 30 pipes the scroll goes from 4.0× to 4.6×, the gaps get smaller, and each height change leaves the bird less time. Resets on death. Off = stay at the starting level.">
            <input type="checkbox" checked={game.ramp} onChange={(e) => { game.ramp = e.target.checked; rerender(); }} />
            Difficulty ramp
          </label>
          <label className="check" title="Measures the state as it will be one round trip from now (if the bird is left alone), which is when Jev's answer lands. Jev still makes the decision.">
            <input type="checkbox" checked={session.settings.lead} onChange={(e) => { session.settings.lead = e.target.checked; rerender(); }} />
            Latency lead
          </label>
          <label className="check" title="Restates the numbers as plain words ('below the gap', 'falling') in the state sent to Jev. Jev still makes the decision.">
            <input type="checkbox" checked={session.settings.words} onChange={(e) => { session.settings.words = e.target.checked; rerender(); }} />
            Describe state in words too
          </label>
          {session.model && <div className="debug-note">model: {session.model}</div>}
          <div className="debug-note">Est. cost = input tokens × $0.042/Mtok (public Jev 1.13 pricing; output tokens are free)</div>
        </div>
      </details>
    </div>
  );
}

function GameCanvas({ game }: { game: Game }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    let raf = 0;
    let prev = performance.now();
    // Render loop runs on its own clock; it never waits for Jev.
    const frame = (now: number) => {
      game.update((now - prev) / 1000);
      prev = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      game.render(ctx);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [game]);
  return <canvas ref={ref} className="game" />;
}

function Hero({ last, offline }: { last: Decision | undefined; offline: boolean }) {
  if (offline) {
    return (
      <section className="hero is-offline">
        <div className="label">Jev decides</div>
        <div className="hero-word">OFFLINE</div>
        <div className="hero-sub">no decision arriving · last known: {last ? `${last.action} #${last.n}` : "none"}</div>
      </section>
    );
  }
  if (!last) {
    return (
      <section className="hero">
        <div className="label">Jev decides</div>
        <div className="hero-word is-idle">…</div>
        <div className="hero-sub">waiting for the first decision</div>
      </section>
    );
  }
  const flap = last.action === "FLAP";
  return (
    <section className={`hero ${flap ? "is-flap" : "is-wait"}`}>
      <div className="label">
        Jev decides <span className="arrow">→</span>
      </div>
      <div className="hero-line">
        {/* Pops once per flap, not on every WAIT in a run of them. */}
        <div key={flap ? last.n : "wait"} className="hero-word">{last.action}</div>
        <div className="hero-pct">{fmtPct(chosenP(last))}</div>
      </div>
      {/* Bar position is Jev's probability for FLAP. Left of centre = WAIT, right = FLAP. */}
      <div className="meter">
        <div className="meter-fill" style={{ width: `${last.pFlap * 100}%` }} />
        <div className="meter-mid" />
      </div>
      <div className="meter-legend">
        <span>WAIT</span>
        <span>P(flap) {last.pFlap.toFixed(2)} · confidence {last.confidence.toFixed(2)}</span>
        <span>FLAP</span>
      </div>
    </section>
  );
}

function StatGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="stat-group">
      <div className="label">{label}</div>
      <div className="stats">{children}</div>
    </section>
  );
}

function Stat({ label, value, strong, bad }: { label: string; value: string; strong?: boolean; bad?: boolean }) {
  return (
    <div className={`stat ${strong ? "is-strong" : ""} ${bad ? "is-bad" : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Stream({ decisions }: { decisions: Decision[] }) {
  const recent = decisions.slice(-12).reverse();
  return (
    <section className="stream">
      <div className="label">Recent decisions</div>
      <div className="stream-rows">
        {recent.map((d) => (
          <div key={d.n} className={`stream-row ${d.action === "FLAP" ? "is-flap" : ""} ${d.superseded ? "is-superseded" : ""}`}>
            <span className="c-n">{d.n}</span>
            <span className="c-a">{d.action}</span>
            <span className="c-bar"><i style={{ width: `${chosenP(d) * 100}%` }} /></span>
            <span className="c-p">{fmtPct(chosenP(d))}</span>
            <span className="c-l">{fmtMs(d.jevMs ?? d.apiMs)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
