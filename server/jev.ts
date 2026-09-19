import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APIError,
  APITimeoutError,
  APIConnectionError,
  choice,
  TypeSafeClient,
  type EntryType,
} from "@typesafe-ai/sdk";
import { FLAP_QUESTION } from "../src/question";

// POST /api/decide  { state } -> { choice, probabilities, confidence, model, usage, latencyMs, requestId }
// Forwards the game state to Jev as a single two-option Choice question. There is no
// fallback: if Jev fails, the error is returned and the UI shows JEV OFFLINE.
export function createJevHandler(env: Record<string, string>) {
  const timeout = Number(env.JEV_TIMEOUT_MS) || 2000;
  let client: TypeSafeClient | null = null;

  const getClient = () =>
    (client ??= new TypeSafeClient({
      apiKey: env.TYPESAFE_API_KEY,
      baseURL: env.TYPESAFE_BASE_URL || undefined,
      defaultModel: env.TYPESAFE_DEFAULT_MODEL || undefined,
      timeout,
      // A retried decision is a stale decision. Fail fast and let the game ask again.
      retry: { maxRetries: 0 },
    }));

  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };

    if (req.method !== "POST") return send(405, { error: { kind: "bad_request", message: "POST only" } });
    if (!env.TYPESAFE_API_KEY?.trim()) {
      return send(503, { error: { kind: "no_api_key", message: "TYPESAFE_API_KEY is not set (see .env.example)" } });
    }

    let state: EntryType;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      state = JSON.parse(Buffer.concat(chunks).toString("utf8")).state;
      if (!state || typeof state !== "object") throw new Error("missing state");
    } catch {
      return send(400, { error: { kind: "bad_request", message: "invalid JSON body" } });
    }

    const started = performance.now();
    try {
      const { data, requestId } = await getClient()
        .systemOne({
          state,
          questions: { action: choice(FLAP_QUESTION.instructions, FLAP_QUESTION.criteria) },
        })
        .withResponse();
      send(200, {
        choice: data.answers.action.choice,
        probabilities: data.answers.action.probabilities,
        confidence: data.answers.action.confidence,
        model: data.model,
        usage: data.usage,
        latencyMs: performance.now() - started,
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
      send(502, { error: { kind, status, message: err instanceof Error ? err.message : String(err) }, latencyMs });
    }
  };
}
