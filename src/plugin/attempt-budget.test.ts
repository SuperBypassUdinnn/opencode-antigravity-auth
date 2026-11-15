import { describe, expect, it } from "vitest";

import { __testExports } from "../plugin.ts";

const { createAttemptBudget } = __testExports;

describe("createAttemptBudget", () => {
  it("numbers attempts from one", () => {
    const budget = createAttemptBudget(3);

    expect(budget.record()).toBe(1);
    expect(budget.record()).toBe(2);
    expect(budget.count).toBe(2);
  });

  it("reports the configured limit", () => {
    expect(createAttemptBudget(42).limit).toBe(42);
  });

  it("stays inside the budget up to and including the limit", () => {
    const budget = createAttemptBudget(2);

    budget.record();
    expect(budget.exhausted).toBe(false);
    budget.record();
    expect(budget.exhausted).toBe(false);
  });

  it("flags exhaustion only after the limit is exceeded", () => {
    const budget = createAttemptBudget(2);

    budget.record();
    budget.record();
    budget.record();

    expect(budget.exhausted).toBe(true);
    expect(budget.count).toBe(3);
  });

  it("keeps counting past the limit so the error can name the total", () => {
    const budget = createAttemptBudget(1);

    for (let i = 0; i < 5; i += 1) {
      budget.record();
    }

    expect(budget.count).toBe(5);
    expect(budget.exhausted).toBe(true);
  });
});
