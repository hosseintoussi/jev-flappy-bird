# Jev Plays Flappy Bird

A live demo of TypeSafe's **Jev** (a System One model) playing Flappy Bird using only repeated, tiny semantic decisions. Every flap comes from a Jev response. There is no fallback player.

```
game state ──► POST /api/decide ──► Jev (Choice: FLAP | WAIT) ──► the bird flaps once on FLAP
        (the canvas keeps rendering on its own clock and never waits for Jev)
```

## Setup

Requires Node 20+.

```sh
npm install
cp .env.example .env      # then paste your key from https://console.typesafe.ai/keys
npm run dev               # http://localhost:5173
```

The API key lives only in the local Node endpoint (`server/jev.ts`, mounted into Vite's dev/preview server). It is never sent to the browser. `npm run build && npm run preview` also works.

| Env var | Default | |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | – | required |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | pin e.g. `jev-1.13.0` for reproducible runs |
| `JEV_TIMEOUT_MS` | `2000` | a slower decision counts as an error |

## How Jev is used

- **Primitive:** a two-option [Choice](https://docs.typesafe.ai/primitives/choice) (`FLAP` / `WAIT`) via `@typesafe-ai/sdk`: `client.systemOne({ state, questions: { action: choice(...) } })`. Jev returns the selected option, a probability for each option, and a `confidence`. The app uses `choice` exactly as returned. **There is no threshold or decision rule in app code.**
- **Question** (`src/question.ts`): *"What should the bird do right now to pass safely through the gap of the next pipe?"* with a description for each option.
- **State** (`src/game.ts`, `observe()`): bird `y` and `velocity_y`, next-pipe distance and gap top/bottom, the pixel clearance from the bird to each gap edge, and the same position/motion restated as plain words (`"inside the gap, lower half"`, `"falling"`). Clearances run from the bird's edges (0 = touching the pipe). These are measurements only: the subtractions are done in code because the [jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13) say Jev is weak at arithmetic and better on semantic than numeric input. Nothing in the state says what to do.
- **Latency lead** (on by default, debug toggle): the state is measured as it will be one round trip from now if the bird is left alone, which is the moment Jev's answer can land. The scroll is constant and only one request is in flight, so nothing else can change the bird in between. It is the same measurement taken at the time it matters; Jev still makes every decision. The lead is a running average of the measured round trip and is logged per decision (`leadMs`).
- **Cadence:** one request in flight at a time, started at most every `interval` ms (default 100). Each FLAP response applies exactly one flap impulse. Rendering is independent of API latency.
- **Retries are off** (`maxRetries: 0`): a retried decision is a stale decision.

### Difficulty ramp, and why the bird floats

Jev's answer takes about **280ms** end to end here, so it makes about 3.5 decisions per second. The **bird's vertical physics run on a slower clock** than the scroll (`BIRD_TIME` in `src/game.ts`, 0.5), so each flap lasts long enough for a 280ms decision to matter.

**The game starts brisk and gets harder with every pipe for the first 30, then stays there; it resets on death** ("Difficulty ramp" in debug; the current speed is on the canvas and in telemetry). The main lever is the **height difference between one gap and the next**:

| | first pipe | pipe 30+ |
| --- | --- | --- |
| scroll speed | 1.3x | 1.9x |
| pipe to pipe | 340px | 295px |
| open air between pipes | ~1.4s | ~0.8s |
| height change, gap to gap | 50 - 110px | 60 - 90px |
| share of the bird's reach that demands | 30 - 55% | 65 - 95% |
| gap height | 195px | 180px |

The bird's physics never change, so how far it can climb or drop between two pipes is fixed by the open air between them, and faster, closer pipes nearly halve that time. Each pipe demands a share of the remaining reach, in a random direction (`START` / `END` in `src/game.ts`). The height changes stay about the same size in pixels while the time to make them shrinks; near 100% the bird has to start moving the moment it clears a pipe and cannot afford a wasted decision, so Jev can and eventually does die at the top level. The debug speed slider still scales the whole game, bird included.

Earlier tunings, measured headless against the live API (same `Game` class, real time, one decision in flight):

| setup | runs | pipes passed | deaths |
| --- | --- | --- | --- |
| before: old question, no lead, fixed 1x, gaps up to 190px apart | 2 x 120s | 82 | 14 |
| new question + latency lead, fixed 1x, small height changes | 2 x 150s | 124 | 0 |

At fixed 1x, each fix alone did not do it (in 150s: new question without lead died 7 - 10 times, lead with the old question 5 times); together they did. The current height-difference ramp has only had a short sanity run, not a long measurement. Each decision costs about 500 input tokens, so a minute of play is roughly 105k tokens, or about $0.26 an hour.

What was killing it, from the decision logs: almost every death came right after a pipe whose successor's gap was lower. The bird sat "above the gap", and either could not fall far enough in time (gap offsets of up to 190px were not actually reachable), or Jev answered FLAP at P~0.5 because the old FLAP option mentioned "falling fast" and flapped into the upper pipe. Stale state made both worse: a decision lands ~280ms after it was asked.

Things that helped, all in the question or state (not in code that plays): option wording that uses the same words as the state's position label, describing options by where the bird is relative to the gap (an earlier "falling toward the bottom" wording made Jev flap whenever the bird was falling, even above the gap), edge-based clearance measurements, plain-word labels, and the latency lead. The game also has a terminal fall speed, like the original, so one late decision is not fatal.

### What is and isn't real

- Probability and confidence come straight from the Choice response. Nothing is fabricated.
- Latency: measured on the local server around the SDK call (`jevLatencyMs`, includes the network to TypeSafe). The browser round trip is logged too (`roundTripMs`).
- Tokens: `usage.input_tokens` / `output_tokens` come from the API response.
- **Est. cost** is calculated, not returned by the API: `input_tokens x $0.042 / 1M` from the public [Models](https://docs.typesafe.ai/models) page (Jev 1.13; output tokens free). Check that page for current pricing.
- **JEV OFFLINE** appears on any error (missing key, 429, timeout, connection failure). The bird just stops getting input. API errors are counted in telemetry.

## Controls

The game never auto-starts: on load (and reload) it waits on a **Ready** screen until you press **Space**. Space then pauses and resumes. After a death it restarts by itself after ~700ms.

Open **debug** (bottom-right): decision interval, game speed, difficulty ramp and latency lead toggles, pause/resume (also **Space**), restart, reset stats, toggle telemetry and the decision stream, **Export JSON**.

"Describe state in words too" (on by default) adds the plain-language labels (`"below the gap"`, `"falling"`) to the state sent to Jev. Turn it off to see Jev work from the numbers alone (it does noticeably worse).

## Session log

**Export JSON** downloads the whole session: per decision, the timestamp, the exact state sent and its `leadMs`, Jev's choice, probabilities and confidence, latency, tokens, model, request id, score, whether it was applied, and `diedAfterMs` (set on every decision of an attempt that ended in death), plus all API errors and a summary.

## Layout

```
server/jev.ts     POST /api/decide → TypeSafe SDK (key stays here)
src/question.ts   the Choice question
src/game.ts       physics, pipes, collisions, canvas drawing (no decision logic)
src/session.ts    decision loop, telemetry, log/export
src/App.tsx       layout, telemetry panel, stream, debug drawer
```

Recording tip: the game and panel form one block centered in the window (about 950×720). Crop to it, and the debug drawer stays out of frame.
