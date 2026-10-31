import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StalledError,
  fetchWithStallGuard,
  isStalledError,
  stallBodyIdleMs,
  stallHeadersTimeoutMs,
} from "./stall-guard";

function streamFrom(chunks: Uint8Array[], close: boolean): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (close) {
        controller.close();
      }
    },
  });
}

const OPTIONS = { headersTimeoutMs: 5_000, bodyIdleMs: 60_000 } as const;

describe("fetchWithStallGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects with StalledError (headers) when fetch never resolves", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const promise = fetchWithStallGuard(fetchFn, "https://example.test", undefined, {
      headersTimeoutMs: 1_000,
      bodyIdleMs: 60_000,
    });
    const assertion = expect(promise).rejects.toMatchObject({
      name: "StalledError",
      phase: "headers",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("passes streaming chunks through and closes cleanly", async () => {
    const encoder = new TextEncoder();
    const fetchFn = async (): Promise<Response> =>
      new Response(streamFrom([encoder.encode("hello "), encoder.encode("world")], true), {
        headers: { "content-type": "text/event-stream" },
      });
    const guarded = await fetchWithStallGuard(fetchFn, "https://example.test", undefined, OPTIONS);
    expect(guarded.status).toBe(200);
    expect(guarded.headers.get("content-type")).toBe("text/event-stream");
    await expect(guarded.text()).resolves.toBe("hello world");
  });

  it("rejects with StalledError (body) when the stream stalls mid-flight", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const fetchFn = async (): Promise<Response> =>
      new Response(streamFrom([encoder.encode("chunk")], false));
    const guarded = await fetchWithStallGuard(fetchFn, "https://example.test", undefined, {
      headersTimeoutMs: 5_000,
      bodyIdleMs: 2_000,
    });
    const reader = guarded.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("chunk");
    const assertion = expect(reader.read()).rejects.toMatchObject({
      name: "StalledError",
      phase: "body",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it("propagates the external abort reason instead of StalledError", async () => {
    const external = new AbortController();
    const encoder = new TextEncoder();
    const fetchFn = async (): Promise<Response> =>
      new Response(streamFrom([encoder.encode("chunk")], false));
    const guarded = await fetchWithStallGuard(
      fetchFn,
      "https://example.test",
      { signal: external.signal },
      OPTIONS,
    );
    const reader = guarded.body!.getReader();
    await reader.read();
    const reason = new Error("user interrupted");
    const assertion = expect(reader.read()).rejects.toBe(reason);
    external.abort(reason);
    await assertion;
  });

  it("throws immediately when the external signal is already aborted", async () => {
    const external = new AbortController();
    const reason = new Error("already cancelled");
    external.abort(reason);
    const fetchFn = vi.fn(async (): Promise<Response> => new Response("nope"));
    await expect(
      fetchWithStallGuard(fetchFn, "https://example.test", { signal: external.signal }, OPTIONS),
    ).rejects.toBe(reason);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns bodyless responses as-is", async () => {
    const empty = new Response(null, { status: 204 });
    const fetchFn = async (): Promise<Response> => empty;
    const guarded = await fetchWithStallGuard(fetchFn, "https://example.test", undefined, OPTIONS);
    expect(guarded).toBe(empty);
  });
});

describe("isStalledError", () => {
  it("distinguishes stall errors from other errors", () => {
    expect(isStalledError(new StalledError("headers", 1_000))).toBe(true);
    expect(isStalledError(new StalledError("body", 1_000))).toBe(true);
    expect(isStalledError(new Error("boom"))).toBe(false);
    expect(isStalledError(undefined)).toBe(false);
    expect(isStalledError(null)).toBe(false);
  });
});

describe("env knobs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to defaults on invalid values", () => {
    vi.stubEnv("OPENCODE_ANTIGRAVITY_STALL_HEADERS_MS", "abc");
    vi.stubEnv("OPENCODE_ANTIGRAVITY_STALL_IDLE_MS", "-5");
    expect(stallHeadersTimeoutMs()).toBe(180_000);
    expect(stallBodyIdleMs()).toBe(300_000);
  });

  it("falls back to defaults on zero and non-finite values", () => {
    vi.stubEnv("OPENCODE_ANTIGRAVITY_STALL_HEADERS_MS", "0");
    vi.stubEnv("OPENCODE_ANTIGRAVITY_STALL_IDLE_MS", "Infinity");
    expect(stallHeadersTimeoutMs()).toBe(180_000);
    expect(stallBodyIdleMs()).toBe(300_000);
  });

  it("uses valid overrides", () => {
    vi.stubEnv("OPENCODE_ANTIGRAVITY_STALL_HEADERS_MS", "45000");
    vi.stubEnv("OPENCODE_ANTIGRAVITY_STALL_IDLE_MS", "60000");
    expect(stallHeadersTimeoutMs()).toBe(45_000);
    expect(stallBodyIdleMs()).toBe(60_000);
  });
});
