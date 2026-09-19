// Minimal Flappy Bird: physics, pipes, collisions, canvas rendering.
// Nothing in this file decides when to flap. The only input is flap(),
// which the Jev controller calls once per FLAP response.

export const W = 480;
export const H = 720;
const GROUND_Y = 650;
const BIRD_X = 140;
const BIRD_R = 15;
const GRAVITY = 900; // px/s^2
const FLAP_VY = -300; // px/s
// The bird's vertical physics run on a slower clock than the scrolling world, so
// pipes can move fast while each flap still lasts long enough for a ~280ms decision to matter.
const BIRD_TIME = 0.5;
// Terminal velocity, like the original. Low enough that one decision period of falling
// (~45px) cannot carry the bird from mid-gap through the bottom of the smallest gap.
const MAX_FALL = 300; // px/s
const PIPE_SPEED = 130; // px/s at pace 1
const PIPE_W = 76;
const HIT_R = BIRD_R - 2; // slightly forgiving hitbox
// Difficulty: every pipe passed moves the run from START toward END over RAMP_PIPES pipes.
// The scroll speeds up, the pipes close in on each other, the gaps get a little smaller, and
// each gap demands more of a climb or drop from the one before it. The bird's vertical physics
// never change, so how far it can move between two pipes is fixed by the time in the open air
// between them, which faster and closer pipes cut from ~1.4s to ~0.8s. `climb` is the share of
// that physical reach a pipe may demand: [least, most]. Near 1 the bird has to start moving as
// soon as it clears a pipe and cannot afford a wasted decision.
const RAMP_PIPES = 30;
const START = { pace: 1.3, spacing: 340, gap: 195, climb: [0.3, 0.55] }; // spacing: px pipe to pipe; gap: px tall
const END = { pace: 1.9, spacing: 295, gap: 180, climb: [0.65, 0.95] };
const FLAP_PERIOD = 0.3; // s between flaps when climbing, about one Jev round trip
const REACTION = 0.35; // s before a climb can start
const REACH_MARGIN = 20; // px kept clear of the gap edge when sizing gap offsets
const RESTART_MS = 700;
const STEP = 1 / 120; // s, fixed physics step
const MAX_FRAME = 0.05; // s, longest frame the simulation will try to catch up on

type Level = typeof START;

/** One physics step for a live bird: gravity, terminal velocity, and the ceiling. */
function fall(y: number, vy: number, dt: number): [y: number, vy: number] {
  vy = Math.min(MAX_FALL, vy + GRAVITY * dt * BIRD_TIME);
  y += vy * dt * BIRD_TIME;
  return y < BIRD_R ? [BIRD_R, Math.max(0, vy)] : [y, vy];
}

interface Pipe {
  x: number;
  gapTop: number;
  gapBottom: number;
  passed: boolean;
}

/** What Jev is shown: plain measurements of one frame (see observe for which one). No advice. */
export interface Observation {
  bird: {
    y: number;
    velocity_y: number;
    clearance_above_bird_to_gap_top: number;
    clearance_below_bird_to_gap_bottom: number;
    position?: string;
    motion?: string;
  };
  next_pipe: { distance_x: number; gap_top_y: number; gap_bottom_y: number };
  y_axis: string;
}

export interface GameEvents {
  onScore?: (score: number) => void;
  onDeath?: (score: number) => void;
  onRestart?: () => void;
}

interface Puff {
  y: number;
  age: number;
}

export class Game {
  birdY = 0;
  birdVy = 0;
  pipes: Pipe[] = [];
  score = 0;
  dead = false;
  paused = true; // never auto-start: the run begins when the user presses space
  started = false;
  speed = 1;
  ramp = true; // difficulty rises with the score; off = stay at START
  pace = START.pace;
  playedMs = 0; // wall-clock time spent actually playing (not paused, not in a hidden tab)
  offline = false;
  events: GameEvents = {};

  private deadFor = 0;
  private acc = 0;
  private scroll = 0;
  private wing = 0;
  private puffs: Puff[] = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.birdY = H * 0.42;
    this.birdVy = 0;
    this.pipes = [];
    this.score = 0;
    this.pace = START.pace;
    this.dead = false;
    this.deadFor = 0;
    this.puffs = [];
    this.spawnPipe(W + 140);
  }

  /** One flap impulse. Called exactly once per FLAP decision from Jev. */
  flap() {
    if (this.dead || this.paused) return;
    this.birdVy = FLAP_VY;
    this.wing = 1;
    this.puffs.push({ y: this.birdY, age: 0 });
  }

  /**
   * leadMs > 0 measures the frame as it will be leadMs of wall-clock time from now if the bird
   * is left alone, which is the moment a decision requested now can land. The scroll is
   * constant and nothing else can flap in between (one request in flight), so this is the
   * same measurement taken at the time it matters, not advice.
   */
  observe(words: boolean, leadMs = 0): Observation | null {
    if (this.dead) return null;
    let birdY = this.birdY;
    let birdVy = this.birdVy;
    let shift = 0;
    for (let t = (leadMs / 1000) * this.speed; t > 0; t -= STEP) {
      const dt = Math.min(STEP, t);
      [birdY, birdVy] = fall(birdY, birdVy, dt);
      shift += PIPE_SPEED * this.pace * dt;
    }
    birdY = Math.min(GROUND_Y - BIRD_R, birdY);
    const pipe = this.nextPipe(shift);
    if (!pipe) return null;
    const y = Math.round(birdY);
    const gapTop = Math.round(pipe.gapTop);
    const gapBottom = Math.round(pipe.gapBottom);
    // Clearances run from the bird's edges, not its centre: 0 means touching the pipe.
    const above = y - HIT_R - gapTop;
    const below = gapBottom - (y + HIT_R);
    const bird: Observation["bird"] = {
      y,
      velocity_y: Math.round(birdVy),
      // Subtractions done in code: the Jev docs say to keep arithmetic out of the model.
      clearance_above_bird_to_gap_top: above,
      clearance_below_bird_to_gap_bottom: below,
    };
    if (words) {
      // The same numbers restated as named buckets, which the docs recommend for
      // numeric state. They describe where the bird is; they never say what to do.
      bird.position =
        above < 0 ? "above the gap"
        : below < 0 ? "below the gap"
        : above < below ? "inside the gap, upper half"
        : "inside the gap, lower half";
      bird.motion =
        birdVy < -60 ? "rising" : birdVy > 250 ? "falling fast" : birdVy > 60 ? "falling" : "level";
    }
    return {
      bird,
      next_pipe: {
        distance_x: Math.max(0, Math.round(pipe.x - shift - (BIRD_X + BIRD_R))),
        gap_top_y: gapTop,
        gap_bottom_y: gapBottom,
      },
      y_axis: "y grows downward; smaller y is higher",
    };
  }

  update(frameDt: number) {
    if (this.paused) return;
    const dt = Math.min(frameDt, MAX_FRAME);
    this.playedMs += dt * 1000;
    this.acc += dt * this.speed;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step(STEP);
    }
  }

  /** The first pipe the bird has not fully cleared, with every pipe `shift` px further along. */
  private nextPipe(shift = 0) {
    return this.pipes.find((p) => p.x - shift + PIPE_W > BIRD_X - BIRD_R);
  }

  /** The difficulty settings once `score` pipes have been passed. */
  private levelAt(score: number): Level {
    const f = this.ramp ? Math.min(1, score / RAMP_PIPES) : 0;
    const mix = (a: number, b: number) => a + (b - a) * f;
    return {
      pace: mix(START.pace, END.pace),
      spacing: mix(START.spacing, END.spacing),
      gap: mix(START.gap, END.gap),
      climb: [mix(START.climb[0], END.climb[0]), mix(START.climb[1], END.climb[1])],
    };
  }

  /** How far (px) a bird cruising at mid-gap can climb or drop before the next pipe arrives. */
  private reach(level: Level) {
    const air = (level.spacing - PIPE_W - 2 * BIRD_R) / (PIPE_SPEED * level.pace); // s between pipes
    const slack = level.gap / 2 - HIT_R - REACH_MARGIN; // it may end up anywhere inside the next gap
    // Down: it just stops flapping and falls.
    let [y, vy] = [GROUND_Y, 0];
    for (let t = air - REACTION / 2; t > 0; t -= STEP) [y, vy] = fall(y, vy, STEP);
    // Up: it keeps falling for REACTION, then climbs one flap per FLAP_PERIOD.
    const tf = FLAP_PERIOD * BIRD_TIME;
    const climbRate = -(FLAP_VY * tf + (GRAVITY * tf * tf) / 2) / FLAP_PERIOD;
    const tr = REACTION * BIRD_TIME;
    const rise = climbRate * (air - REACTION) - (GRAVITY * tr * tr) / 2;
    return { up: slack + rise, down: slack + (y - GROUND_Y) };
  }

  private spawnPipe(x: number, level = this.spawnLevel()) {
    const margin = 70;
    const lo = margin + level.gap / 2;
    const hi = GROUND_Y - margin - level.gap / 2;
    const prev = this.pipes[this.pipes.length - 1];
    let center = lo + Math.random() * (hi - lo);
    if (prev) {
      // The level decides how much of the bird's reach this pipe demands, in a random direction.
      const reach = this.reach(level);
      const share = level.climb[0] + Math.random() * (level.climb[1] - level.climb[0]);
      const prevCenter = (prev.gapTop + prev.gapBottom) / 2;
      const up = prevCenter - share * reach.up;
      const down = prevCenter + share * reach.down;
      const goUp = up < lo ? false : down > hi ? true : Math.random() < 0.5;
      center = Math.max(lo, Math.min(hi, goUp ? up : down));
    }
    this.pipes.push({ x, gapTop: center - level.gap / 2, gapBottom: center + level.gap / 2, passed: false });
  }

  /** The level the run will have reached by the time a pipe spawned now gets to the bird. */
  private spawnLevel() {
    return this.levelAt(this.score + this.pipes.filter((p) => !p.passed).length);
  }

  private step(dt: number) {
    this.wing = Math.max(0, this.wing - dt * 4);
    for (const p of this.puffs) p.age += dt;
    this.puffs = this.puffs.filter((p) => p.age < 0.6);

    if (this.dead) {
      this.deadFor += dt / this.speed; // restart delay is wall-clock, not game-speed
      // The body drops to the ground, with no terminal velocity.
      this.birdVy += GRAVITY * dt * BIRD_TIME;
      this.birdY = Math.min(GROUND_Y - BIRD_R, this.birdY + this.birdVy * dt * BIRD_TIME);
      if (this.deadFor * 1000 >= RESTART_MS) {
        this.reset();
        this.events.onRestart?.();
      }
      return;
    }

    // Ease toward the pace for this score so a scored pipe doesn't jolt the scroll.
    this.pace += (this.levelAt(this.score).pace - this.pace) * Math.min(1, dt * 2);
    const dx = PIPE_SPEED * this.pace * dt;
    this.scroll += dx;
    [this.birdY, this.birdVy] = fall(this.birdY, this.birdVy, dt);

    for (const p of this.pipes) {
      p.x -= dx;
      if (!p.passed && p.x + PIPE_W < BIRD_X - BIRD_R) {
        p.passed = true;
        this.score += 1;
        this.events.onScore?.(this.score);
      }
    }
    this.pipes = this.pipes.filter((p) => p.x + PIPE_W > -10);
    // Spawn just off-screen, so a pipe never pops into view.
    const last = this.pipes[this.pipes.length - 1];
    const level = this.spawnLevel();
    const next = last.x + level.spacing;
    if (next <= W + 20) this.spawnPipe(next, level);

    if (this.collides()) {
      this.dead = true;
      this.deadFor = 0;
      this.birdVy = -180;
      this.events.onDeath?.(this.score);
    }
  }

  private collides() {
    if (this.birdY + BIRD_R >= GROUND_Y) return true;
    return this.pipes.some(
      (p) =>
        BIRD_X + HIT_R > p.x && BIRD_X - HIT_R < p.x + PIPE_W &&
        (this.birdY - HIT_R < p.gapTop || this.birdY + HIT_R > p.gapBottom),
    );
  }

  // ---------------------------------------------------------------- render

  render(ctx: CanvasRenderingContext2D) {
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0, "#2b6cf0");
    sky.addColorStop(0.55, "#58b8f5");
    sky.addColorStop(1, "#bfeaf7");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    this.drawClouds(ctx);
    this.drawHills(ctx);
    for (const p of this.pipes) this.drawPipe(ctx, p);
    this.drawGround(ctx);
    this.drawPuffs(ctx);
    this.drawBird(ctx);
    this.drawHud(ctx);
  }

  private drawClouds(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#e4f1ff";
    const span = W + 240;
    for (let i = 0; i < 4; i++) {
      const x = ((i * 190 + 60 - this.scroll * 0.15) % span + span) % span - 120;
      const y = 80 + ((i * 97) % 170);
      const s = 0.8 + ((i * 37) % 5) / 10;
      for (const [dx, dy, rx, ry] of [[0, 0, 46, 17], [28, -12, 30, 17], [-26, -7, 24, 13]]) {
        ctx.beginPath();
        ctx.ellipse(x + dx * s, y + dy * s, rx * s, ry * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawHills(ctx: CanvasRenderingContext2D) {
    const layers = [
      { color: "#7fd0c0", amp: 38, base: GROUND_Y - 58, par: 0.3, freq: 0.011 },
      { color: "#4fb68f", amp: 26, base: GROUND_Y - 26, par: 0.55, freq: 0.017 },
    ];
    for (const l of layers) {
      ctx.fillStyle = l.color;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      for (let x = 0; x <= W; x += 8) {
        const t = (x + this.scroll * l.par) * l.freq;
        ctx.lineTo(x, l.base - Math.sin(t) * l.amp - Math.sin(t * 2.3 + 1) * l.amp * 0.4);
      }
      ctx.lineTo(W, GROUND_Y);
      ctx.fill();
    }
  }

  private drawPipe(ctx: CanvasRenderingContext2D, p: Pipe) {
    const body = (x: number, y: number, w: number, h: number) => {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, "#1f9d49");
      g.addColorStop(0.25, "#5fe07f");
      g.addColorStop(0.6, "#2fb957");
      g.addColorStop(1, "#15803a");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#0d5a28";
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    };
    const capH = 30;
    body(p.x + 5, -4, PIPE_W - 10, p.gapTop - capH + 6);
    body(p.x, p.gapTop - capH, PIPE_W, capH);
    body(p.x + 5, p.gapBottom + capH - 2, PIPE_W - 10, GROUND_Y - p.gapBottom - capH + 4);
    body(p.x, p.gapBottom, PIPE_W, capH);
  }

  private drawGround(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#e3c98a";
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.fillStyle = "#6fcf4f";
    ctx.fillRect(0, GROUND_Y, W, 16);
    ctx.fillStyle = "#57b53c";
    const off = this.scroll % 28;
    for (let x = -28 - off; x < W + 28; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y + 16);
      ctx.lineTo(x + 14, GROUND_Y);
      ctx.lineTo(x + 28, GROUND_Y);
      ctx.lineTo(x + 14, GROUND_Y + 16);
      ctx.fill();
    }
    ctx.fillStyle = "#3e8f2b";
    ctx.fillRect(0, GROUND_Y + 16, W, 3);
  }

  private drawPuffs(ctx: CanvasRenderingContext2D) {
    for (const p of this.puffs) {
      const t = p.age / 0.6;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(BIRD_X - p.age * PIPE_SPEED * this.pace, p.y + 14, 8 + t * 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "800 13px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText("FLAP", BIRD_X - 44 - p.age * 30, p.y + 6 + t * 10);
      ctx.restore();
    }
  }

  private drawBird(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.translate(BIRD_X, this.birdY);
    ctx.rotate(Math.max(-0.5, Math.min(1.2, this.birdVy / 520)));
    // body
    ctx.fillStyle = "#ffd23f";
    ctx.strokeStyle = "#3a2a00";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, BIRD_R + 4, BIRD_R, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // belly
    ctx.fillStyle = "#fff1b0";
    ctx.beginPath();
    ctx.ellipse(1, 6, 11, 6, 0, 0, Math.PI);
    ctx.fill();
    // wing
    const flapY = -this.wing * 9;
    ctx.fillStyle = "#ffb703";
    ctx.beginPath();
    ctx.ellipse(-6, 2 + flapY, 9, 6 + this.wing * 3, -0.3 - this.wing * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // eye
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(9, -6, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1a1a1a";
    if (this.dead) {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(6, -9); ctx.lineTo(12, -3);
      ctx.moveTo(12, -9); ctx.lineTo(6, -3);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(11, -6, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // beak
    ctx.fillStyle = "#ff7b1c";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(15, -1);
    ctx.lineTo(28, 3);
    ctx.lineTo(15, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = "800 64px ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', sans-serif";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(10,20,50,0.55)";
    ctx.fillStyle = "#fff";
    ctx.strokeText(String(this.score), W / 2, 92);
    ctx.fillText(String(this.score), W / 2, 92);
    if (this.ramp && this.started) {
      ctx.font = "800 15px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.lineWidth = 4;
      ctx.strokeText(`SPEED ${this.pace.toFixed(2)}×`, W / 2, 120);
      ctx.fillText(`SPEED ${this.pace.toFixed(2)}×`, W / 2, 120);
    }

    const banner = (text: string, sub: string, color: string, cy = H / 2) => {
      ctx.fillStyle = "rgba(8,10,16,0.72)";
      ctx.fillRect(0, cy - 74, W, 124);
      ctx.fillStyle = color;
      ctx.font = "800 44px ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', sans-serif";
      ctx.fillText(text, W / 2, cy - 8);
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "600 15px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(sub, W / 2, cy + 24);
    };
    if (this.dead) banner("Jev died", `score ${this.score} · restarting`, "#ff5d5d");
    else if (!this.started) banner("Ready", "press SPACE to start", "#fff", 190);
    else if (this.paused) banner("Paused", "press SPACE to resume", "#fff", 190);
    else if (this.offline) {
      ctx.fillStyle = "rgba(8,10,16,0.72)";
      ctx.fillRect(0, GROUND_Y - 44, W, 34);
      ctx.fillStyle = "#ff5d5d";
      ctx.font = "800 15px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText("JEV OFFLINE · no decisions arriving", W / 2, GROUND_Y - 22);
    }
    ctx.restore();
  }
}
