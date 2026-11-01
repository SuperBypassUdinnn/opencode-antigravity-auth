import { describe, expect, it } from "vitest";

import { __testExports } from "../plugin.ts";

const { SILENT_WAIT_BUDGET_MS, createSilentWaitBudget, sleepWithinBudget } = __testExports;

function recordingDebug(): { lines: string[]; debug: (line: string) => void } {
  const lines: string[] = [];
  return { lines, debug: (line: string) => lines.push(line) };
}

describe("sleepWithinBudget", () => {
  it("sleeps while the attempt still has budget left", async () => {
    const budget = createSilentWaitBudget();
    const { lines, debug } = recordingDebug();

    await sleepWithinBudget(budget, 5, "test wait", debug);

    expect(budget.spentMs).toBe(5);
    expect(lines).toEqual([]);
  });

  it("records every wait so a chain cannot outrun the budget", async () => {
    const budget = createSilentWaitBudget();
    const { debug } = recordingDebug();
    budget.spentMs = SILENT_WAIT_BUDGET_MS - 10;

    await expect(sleepWithinBudget(budget, 20, "chain wait", debug)).rejects.toThrow(/45s client watchdog/);
    expect(budget.spentMs).toBe(SILENT_WAIT_BUDGET_MS - 10);
  });

  it("keeps the budget bound below the client watchdog window", () => {
    expect(SILENT_WAIT_BUDGET_MS).toBeLessThan(45_000);
  });

  it("reports the refused wait instead of sleeping", async () => {
    const budget = createSilentWaitBudget();
    const { lines, debug } = recordingDebug();
    budget.spentMs = SILENT_WAIT_BUDGET_MS;

    const startedAt = Date.now();
    await expect(sleepWithinBudget(budget, 5_000, "all accounts rate-limited", debug)).rejects.toThrow(
      /Cannot wait .* for all accounts rate-limited/,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(lines.join("\n")).toMatch(/silent-wait budget exhausted: refusing 5000ms wait \(all accounts rate-limited\)/);
  });

  it("still propagates user aborts untouched", async () => {
    const budget = createSilentWaitBudget();
    const { debug } = recordingDebug();
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    controller.abort(reason);

    await expect(sleepWithinBudget(budget, 10, "abort test", debug, controller.signal)).rejects.toBe(reason);
  });

  it("prefers the user abort over an exhausted budget", async () => {
    const budget = createSilentWaitBudget();
    const { debug } = recordingDebug();
    budget.spentMs = SILENT_WAIT_BUDGET_MS;
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    controller.abort(reason);

    await expect(sleepWithinBudget(budget, 5_000, "abort test", debug, controller.signal)).rejects.toBe(reason);
  });
});
