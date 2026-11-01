/**
 * Stall guard for upstream chat requests.
 *
 * The upstream occasionally stops sending data without ever closing the
 * connection. Without an explicit deadline such a request hangs forever: the
 * abort never gets a chance to run, the user's only escape is killing the
 * server process, and that death/replacement cycle is what produced the
 * "server restarted while you were working" restart loop. This module wraps
 * the loader fetch with two deadlines:
 *
 * The deadlines stay below the 45s event-stream idle watchdog the TUI client
 * runs against its server, so a stall surfaces as a plugin-level abort and
 * retry (which keeps events flowing) instead of the client declaring the
 * stream dead and replacing the server process.
 *
 * - headers: the fetch call itself must settle within `headersTimeoutMs`
 *   (default 30s, env OPENCODE_ANTIGRAVITY_STALL_HEADERS_MS).
 * - body: while streaming the response, an idle timer resets on every chunk;
 *   if no chunk arrives for `bodyIdleMs` (default 25s, env
 *   OPENCODE_ANTIGRAVITY_STALL_IDLE_MS) the stream is aborted.
 *
 * Both deadlines raise a StalledError, which the retry loop treats like a
 * network error (bounded backoff, endpoint/account switch). User aborts
 * arriving through the external signal still propagate untouched and are
 * never classified as stalls.
 */

const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 25_000;

export type StalledPhase = "headers" | "body";

export class StalledError extends Error {
  readonly phase: StalledPhase;
  readonly idleMs: number;

  constructor(phase: StalledPhase, idleMs: number) {
    super(`Antigravity request stalled (${phase}): no data for ${Math.round(idleMs / 1000)}s`);
    this.name = "StalledError";
    this.phase = phase;
    this.idleMs = idleMs;
  }
}

export function isStalledError(error: unknown): error is StalledError {
  return error instanceof Error && error.name === "StalledError";
}

function parseTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Headers deadline in ms (env: OPENCODE_ANTIGRAVITY_STALL_HEADERS_MS). */
export function stallHeadersTimeoutMs(): number {
  return parseTimeoutEnv("OPENCODE_ANTIGRAVITY_STALL_HEADERS_MS", DEFAULT_HEADERS_TIMEOUT_MS);
}

/** Body idle deadline in ms (env: OPENCODE_ANTIGRAVITY_STALL_IDLE_MS). */
export function stallBodyIdleMs(): number {
  return parseTimeoutEnv("OPENCODE_ANTIGRAVITY_STALL_IDLE_MS", DEFAULT_BODY_IDLE_TIMEOUT_MS);
}

export interface StallGuardOptions {
  /** Override for the headers deadline (ms). */
  headersTimeoutMs?: number;
  /** Override for the body idle deadline (ms). */
  bodyIdleMs?: number;
}

type FetchFn = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

function abortError(): Error {
  // Match the shape undici uses for aborted fetches so callers can treat it
  // like any other user-initiated abort.
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Races a body pump against aborts at the read level, so a stall is detected
 * even if the underlying body ignores the abort signal.
 */
function monitorBody(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleMs: number,
  aborted: Promise<never>,
  detach: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearIdleTimer();
    detach();
  };

  const armIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      controller.abort(new StalledError("body", idleMs));
    }, idleMs);
    unrefTimer(idleTimer);
  };

  const pump = async (sink: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    try {
      for (;;) {
        armIdleTimer();
        const read = reader.read();
        // If the abort race wins, the orphaned read must not surface later as
        // an unhandled rejection.
        void read.catch(() => {});
        const result = await Promise.race([read, aborted]);
        if (result.done) {
          finish();
          sink.close();
          return;
        }
        sink.enqueue(result.value);
      }
    } catch (error) {
      finish();
      // Best effort: release the underlying body even when it ignores aborts.
      void reader.cancel(error).catch(() => {});
      try {
        sink.error(error);
      } catch {
        // Sink already errored or closed.
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    start(sink) {
      pump(sink).catch(() => {
        // The error was already delivered through sink.error().
      });
    },
    cancel(reason) {
      finish();
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Wraps a fetch function with stall detection. Deadlines come from `options`
 * when provided, otherwise from the environment with the defaults documented
 * at the top of this file.
 */
export async function fetchWithStallGuard(
  fetchFn: FetchFn,
  input: RequestInfo,
  init?: RequestInit,
  options?: StallGuardOptions,
): Promise<Response> {
  const headersTimeoutMs = options?.headersTimeoutMs ?? stallHeadersTimeoutMs();
  const bodyIdleMs = options?.bodyIdleMs ?? stallBodyIdleMs();

  const externalSignal = init?.signal;
  if (externalSignal?.aborted) {
    throw externalSignal.reason ?? abortError();
  }

  const controller = new AbortController();

  let abortReject: ((reason: unknown) => void) | undefined;
  const aborted: Promise<never> = new Promise<never>((_, reject) => {
    abortReject = reject;
  });
  // This promise often loses races or stays pending; never let its rejection
  // surface as an unhandled rejection.
  aborted.catch(() => {});

  const onSignalAbort = () => {
    abortReject?.(controller.signal.reason ?? abortError());
  };
  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason ?? abortError());
  };
  const detach = () => {
    controller.signal.removeEventListener("abort", onSignalAbort);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  };

  controller.signal.addEventListener("abort", onSignalAbort, { once: true });
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const headersTimer = setTimeout(() => {
    controller.abort(new StalledError("headers", headersTimeoutMs));
  }, headersTimeoutMs);
  unrefTimer(headersTimer);

  let response: Response;
  try {
    response = await Promise.race([
      fetchFn(input, { ...init, signal: controller.signal }),
      aborted,
    ]);
  } catch (error) {
    clearTimeout(headersTimer);
    detach();
    throw error;
  }
  clearTimeout(headersTimer);

  if (!response.body) {
    detach();
    return response;
  }

  const monitored = monitorBody(response.body, controller, bodyIdleMs, aborted, detach);
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
