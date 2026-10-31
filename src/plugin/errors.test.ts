import { describe, expect, it } from "vitest";
import { EmptyResponseError, ToolIdMismatchError } from "./errors";
import { StalledError } from "./stall-guard";
import { isNetworkError } from "../plugin.ts";

// ─── EmptyResponseError ───────────────────────────────────────────────────────

describe("EmptyResponseError", () => {
  it("is an instance of Error", () => {
    const err = new EmptyResponseError("gemini", "gemini-2.5-flash", 3);
    expect(err).toBeInstanceOf(Error);
  });

  it("has name EmptyResponseError", () => {
    const err = new EmptyResponseError("gemini", "gemini-2.5-flash", 3);
    expect(err.name).toBe("EmptyResponseError");
  });

  it("stores provider, model, and attempts on the instance", () => {
    const err = new EmptyResponseError("anthropic", "claude-3-5-sonnet", 5);
    expect(err.provider).toBe("anthropic");
    expect(err.model).toBe("claude-3-5-sonnet");
    expect(err.attempts).toBe(5);
  });

  it("generates a default message that mentions the attempt count", () => {
    const err = new EmptyResponseError("gemini", "model-x", 2);
    expect(err.message).toContain("2");
    expect(err.message).toContain("attempts");
  });

  it("uses a custom message when provided", () => {
    const err = new EmptyResponseError("gemini", "model-x", 1, "custom error msg");
    expect(err.message).toBe("custom error msg");
  });

  it("works with attempts = 1 (singular language check)", () => {
    const err = new EmptyResponseError("p", "m", 1);
    expect(err.message).toContain("1");
  });

  it("can be thrown and caught as an Error", () => {
    expect(() => {
      throw new EmptyResponseError("gemini", "model", 1);
    }).toThrow(EmptyResponseError);
  });

  it("is also catchable as a generic Error", () => {
    expect(() => {
      throw new EmptyResponseError("gemini", "model", 1);
    }).toThrow(Error);
  });
});

// ─── ToolIdMismatchError ──────────────────────────────────────────────────────

describe("ToolIdMismatchError", () => {
  it("is an instance of Error", () => {
    const err = new ToolIdMismatchError(["tool_1"], ["tool_2"]);
    expect(err).toBeInstanceOf(Error);
  });

  it("has name ToolIdMismatchError", () => {
    const err = new ToolIdMismatchError(["a"], ["b"]);
    expect(err.name).toBe("ToolIdMismatchError");
  });

  it("stores expectedIds and foundIds on the instance", () => {
    const expected = ["tool_a", "tool_b"];
    const found = ["tool_c"];
    const err = new ToolIdMismatchError(expected, found);
    expect(err.expectedIds).toEqual(expected);
    expect(err.foundIds).toEqual(found);
  });

  it("generates a default message mentioning both id lists", () => {
    const err = new ToolIdMismatchError(["x", "y"], ["z"]);
    expect(err.message).toContain("x");
    expect(err.message).toContain("y");
    expect(err.message).toContain("z");
  });

  it("uses a custom message when provided", () => {
    const err = new ToolIdMismatchError(["a"], ["b"], "my custom message");
    expect(err.message).toBe("my custom message");
  });

  it("handles empty arrays without throwing", () => {
    const err = new ToolIdMismatchError([], []);
    expect(err.expectedIds).toEqual([]);
    expect(err.foundIds).toEqual([]);
  });

  it("can be thrown and caught as an Error", () => {
    expect(() => {
      throw new ToolIdMismatchError(["a"], ["b"]);
    }).toThrow(ToolIdMismatchError);
  });

  it("preserves array references exactly", () => {
    const expected = ["id-1"];
    const found = ["id-2"];
    const err = new ToolIdMismatchError(expected, found);
    expect(err.expectedIds).toBe(expected);
    expect(err.foundIds).toBe(found);
  });
});

// ─── isNetworkError ─────────────────────────────────────────────────────────────

describe("isNetworkError", () => {
  it("returns false for null/undefined", () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it("returns false for AbortError", () => {
    const abortError = new DOMException("Aborted", "AbortError");
    expect(isNetworkError(abortError)).toBe(false);
  });

  it("detects Node.js ECONNRESET error code", () => {
    const error = new Error("Connection reset");
    (error as any).code = "ECONNRESET";
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects Node.js ECONNREFUSED error code", () => {
    const error = new Error("Connection refused");
    (error as any).code = "ECONNREFUSED";
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects Node.js ETIMEDOUT error code", () => {
    const error = new Error("Timed out");
    (error as any).code = "ETIMEDOUT";
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects Node.js ENOTFOUND error code", () => {
    const error = new Error("Not found");
    (error as any).code = "ENOTFOUND";
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects TypeError with network message", () => {
    const error = new TypeError("Network request failed");
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects TypeError with fetch message", () => {
    const error = new TypeError("Failed to fetch");
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects TypeError with connection reset message", () => {
    const error = new TypeError("socket hang up");
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects Error with connection reset message", () => {
    const error = new Error("Connection reset by peer");
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects Error with connection refused message", () => {
    const error = new Error("Connection refused");
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects Error with timed out message", () => {
    const error = new Error("Request timed out");
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects Error with network message", () => {
    const error = new Error("Network error occurred");
    expect(isNetworkError(error)).toBe(true);
  });

  it("returns false for regular Error without network message", () => {
    const error = new Error("Some other error");
    expect(isNetworkError(error)).toBe(false);
  });

  it("detects fetch AbortError by name", () => {
    const error = new Error("Aborted");
    error.name = "AbortError";
    expect(isNetworkError(error)).toBe(false);
  });

  it("detects EAI_SOCKET error code", () => {
    const error = new Error("EAI_SOCKET");
    (error as any).code = "EAI_SOCKET";
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects EPIPE error code", () => {
    const error = new Error("EPIPE");
    (error as any).code = "EPIPE";
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects ENOTCONN error code", () => {
    const error = new Error("ENOTCONN");
    (error as any).code = "ENOTCONN";
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects ESHUTDOWN error code", () => {
    const error = new Error("ESHUTDOWN");
    (error as any).code = "ESHUTDOWN";
    expect(isNetworkError(error)).toBe(true);
  });
});

describe("isNetworkError stall classification", () => {
  it("treats StalledError as retryable", () => {
    expect(isNetworkError(new StalledError("headers", 180_000))).toBe(true);
    expect(isNetworkError(new StalledError("body", 300_000))).toBe(true);
  });

  it("never classifies a user abort as retryable", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(isNetworkError(abort)).toBe(false);
  });
});
