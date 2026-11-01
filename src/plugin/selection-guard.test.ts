import { describe, expect, it } from "vitest";

import { __testExports } from "../plugin.ts";

const { createSelectionGuard } = __testExports;

describe("createSelectionGuard", () => {
  it("does not signal the first skip of an account", () => {
    const guard = createSelectionGuard();

    expect(guard.recordSkip("a@example.test")).toBe(false);
  });

  it("does not signal while each round skips a different account", () => {
    const guard = createSelectionGuard();

    expect(guard.recordSkip("a@example.test")).toBe(false);
    expect(guard.recordSkip("b@example.test")).toBe(false);
    expect(guard.recordSkip("c@example.test")).toBe(false);
  });

  it("signals when a skipped account comes around again", () => {
    const guard = createSelectionGuard();

    expect(guard.recordSkip("a@example.test")).toBe(false);
    expect(guard.recordSkip("b@example.test")).toBe(false);
    expect(guard.recordSkip("a@example.test")).toBe(true);
  });

  it("forgets skipped accounts after a request attempt", () => {
    const guard = createSelectionGuard();

    expect(guard.recordSkip("a@example.test")).toBe(false);
    guard.recordAttempt();
    expect(guard.recordSkip("a@example.test")).toBe(false);
  });

  it("keeps signalling until a request attempt happens", () => {
    const guard = createSelectionGuard();

    expect(guard.recordSkip("a@example.test")).toBe(false);
    expect(guard.recordSkip("a@example.test")).toBe(true);
    expect(guard.recordSkip("a@example.test")).toBe(true);
  });
});
