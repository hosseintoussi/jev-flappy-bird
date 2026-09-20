import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, fetch as h2Fetch } from "undici";
import {
  APIError,
  APITimeoutError,
  APIConnectionError,
  choice,
  TypeSafeClient,
  type EntryType,
  type Fetch,
} from "@typesafe-ai/sdk";
import { FLAP_QUESTION } from "../src/question";

const WARM_EVERY_MS = 20_000;
const WARM_FOR_MS = 10 * 60_000; // stop keeping the connection warm this long after the last decision (or server start)

// GET  /api/decide/stream?client=ID   one long-lived event stream per page; every answer comes back on it
// POST /api/decide  { client, rid, state } -> 202 at once. The answer follows on the stream as
//   { rid, status: 200, body: { choice, probabilities, confidence, model, usage, latencyMs, jevMs, requestId } }
//   or { rid, status: 502, body: { error, latencyMs } }.
// Forwards the game state to Jev as a single two-option Choice question. There is no
// fallback: if Jev fails, the error is returned and the UI shows JEV OFFLINE.
//
// Why not answer on the POST itself: a browser opens at most six HTTP/1.1 connections to a
// host, and more questions than that are in flight. The rest would queue inside the browser
// and their answers would land a whole round trip late.
export function createJevHandler(env: Record<string, string>) {
  const timeout = Number(env.JEV_TIMEOUT_MS) || 2000;
  let client: TypeSafeClient | null = null;
  const streams = new Map<string, ServerResponse>();
  let lastDecisionAt = performance.now();
  let warmer: ReturnType<typeof setInterval> | undefined;

  // Several decisions are in flight at once. Over HTTP/1.1 each would need its own connection,
  // and a new connection costs a TLS handshake (two extra round trips) in the middle of a run.
  // HTTP/2 carries them all on one connection that is already open.
  const dispatcher = new Agent({ allowH2: true, keepAliveTimeout: 60_000 });
  // undici's fetch is the one Node ships; only its TypeScript types differ from the global ones.
  const fetch = ((url: string, init?: object) => h2Fetch(url, { ...init, dispatcher })) as unknown as Fetch;

  const getClient = () =>
    (client ??= new TypeSafeClient({
      apiKey: env.TYPESAFE_API_KEY,
      baseURL: env.TYPESAFE_BASE_URL || undefined,
      defaultModel: env.TYPESAFE_DEFAULT_MODEL || undefined,
      fetch,
      timeout,
      // A retried decision is a stale decision. Fail fast and let the game ask again.
      retry: { maxRetries: 0 },
    }));

  // Opens the connection before the first decision needs it, and keeps it open through pauses.
  // Listing models is not a Jev call and uses no tokens.
  const warm = () => void getClient().models.list({ timeout: 5000 }).then(null, () => {});
  const keepWarm = () => {
    if (warmer || !env.TYPESAFE_API_KEY?.trim()) return;
    warm();
    warmer = setInterval(() => {
      const idle = performance.now() - lastDecisionAt;
      if (idle > WARM_FOR_MS) warmer = void clearInterval(warmer);
      else if (idle > WARM_EVERY_MS / 2) warm();
    }, WARM_EVERY_MS).unref();
  };
  keepWarm();

  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };

    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/stream") {
      const client = url.searchParams.get("client");
      if (!client) return send(400, { error: { kind: "bad_request", message: "missing client" } });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
      res.write(": connected\n\n");
      streams.set(client, res);
      req.on("close", () => streams.get(client) === res && streams.delete(client));
      return;
    }

    if (req.method !== "POST") return send(405, { error: { kind: "bad_request", message: "POST only" } });
    if (!env.TYPESAFE_API_KEY?.trim()) {
      return send(503, { error: { kind: "no_api_key", message: "TYPESAFE_API_KEY is not set (see .env.example)" } });
    }

    let state: EntryType;
    let rid: number;
    let stream: ServerResponse | undefined;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      ({ state, rid } = body);
      stream = streams.get(body.client);
      if (!state || typeof state !== "object") throw new Error("missing state");
    } catch {
      return send(400, { error: { kind: "bad_request", message: "invalid JSON body" } });
    }
    if (!stream) return send(409, { error: { kind: "no_stream", message: "open /api/decide/stream first" } });
    send(202, {});
    const answer = (status: number, body: unknown) => void stream.write(`data: ${JSON.stringify({ rid, status, body })}\n\n`);

    lastDecisionAt = performance.now();
    keepWarm();

    const started = performance.now();
    try {
      const { data, response, requestId } = await getClient()
        .systemOne({
          state,
          questions: { action: choice(FLAP_QUESTION.instructions, FLAP_QUESTION.criteria) },
        })
        .withResponse();
      answer(200, {
        choice: data.answers.action.choice,
        probabilities: data.answers.action.probabilities,
        confidence: data.answers.action.confidence,
        model: data.model,
        usage: data.usage,
        latencyMs: performance.now() - started,
        // Time TypeSafe's own gateway measured from receiving the request to having the answer.
        // The rest of latencyMs is the network between this machine and the API.
        jevMs: Number(response.headers.get("x-envoy-upstream-service-time")) || null,
        requestId,
      });
    } catch (err) {
      const latencyMs = performance.now() - started;
      const kind =
        err instanceof APITimeoutError ? "timeout"
        : err instanceof APIConnectionError ? "connection"
        : err instanceof APIError ? (err.status === 429 ? "rate_limited" : `http_${err.status}`)
        : "unknown";
      const status = err instanceof APIError ? err.status : undefined;
      answer(502, { error: { kind, status, message: err instanceof Error ? err.message : String(err) }, latencyMs });
    }
  };
}
