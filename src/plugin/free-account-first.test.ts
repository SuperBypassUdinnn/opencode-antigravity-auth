import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountManager } from "./accounts";
import type { AccountStorageV4 } from "./storage";

vi.mock("./storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storage")>();
  return {
    ...original,
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    saveAccountsReplace: vi.fn().mockResolvedValue(undefined),
    updateAccounts: vi.fn().mockResolvedValue(null),
  };
});

const FUTURE = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();

/** A Pro account: the argon group is what identifies the paid tier. */
function proAccount(refreshToken: string, overrides: Record<string, unknown> = {}) {
  return {
    refreshToken,
    projectId: "project",
    addedAt: 1,
    lastUsed: 1,
    cachedQuota: {
      "gemini-argon": {
        remainingFraction: 1,
        weeklyRemainingFraction: 1,
        weeklyResetTime: FUTURE,
        modelCount: 1,
        models: { "gemini-4-argon-high": { remainingFraction: 1, resetTime: FUTURE } },
      },
    },
    cachedQuotaUpdatedAt: Date.now(),
    ...overrides,
  };
}

/** A free account with no weekly bucket: its weekly window has not started. */
function freeAccount(refreshToken: string, overrides: Record<string, unknown> = {}) {
  return {
    refreshToken,
    projectId: "project",
    addedAt: 1,
    lastUsed: 1,
    cachedQuota: {
      "gemini-flash": { remainingFraction: 1, modelCount: 1 },
    },
    cachedQuotaUpdatedAt: Date.now(),
    ...overrides,
  };
}

function managerWith(accounts: AccountStorageV4["accounts"]): AccountManager {
  return new AccountManager(undefined, { version: 4, activeIndex: 0, accounts }, false);
}

describe("free account weekly warm-up", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("selects a free account with an unstarted weekly window before a Pro account", () => {
    const manager = managerWith([proAccount("pro"), freeAccount("free")]);

    const selected = manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "round-robin");

    expect(selected?.parts.refreshToken).toBe("free");
  });

  it("spends only one request per free account, then returns to normal ranking", () => {
    const manager = managerWith([proAccount("pro"), freeAccount("free")]);

    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "round-robin")?.parts.refreshToken).toBe("free");
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "round-robin")?.parts.refreshToken).toBe("pro");
  });

  it("does not leave the family cursor on the warmed account", () => {
    const manager = managerWith([proAccount("pro"), freeAccount("free")]);

    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "sticky")?.parts.refreshToken).toBe("free");
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "sticky")?.parts.refreshToken).toBe("pro");
  });

  it("leaves a free account alone while its weekly countdown is running", () => {
    const manager = managerWith([
      proAccount("pro"),
      freeAccount("free", {
        cachedQuota: {
          "gemini-flash": {
            remainingFraction: 1,
            weeklyRemainingFraction: 1,
            weeklyResetTime: FUTURE,
            modelCount: 1,
          },
        },
      }),
    ]);

    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "round-robin")?.parts.refreshToken).toBe("pro");
  });

  it("re-warms a free account whose weekly window has already elapsed", () => {
    const manager = managerWith([
      proAccount("pro"),
      freeAccount("free", {
        cachedQuota: {
          "gemini-flash": {
            remainingFraction: 1,
            weeklyRemainingFraction: 1,
            weeklyResetTime: PAST,
            modelCount: 1,
          },
        },
      }),
    ]);

    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "round-robin")?.parts.refreshToken).toBe("free");
  });

  it("never guesses the plan of an account without a quota snapshot", () => {
    const manager = managerWith([
      proAccount("pro"),
      { refreshToken: "unknown", projectId: "project", addedAt: 1, lastUsed: 1 },
    ]);

    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "round-robin")?.parts.refreshToken).toBe("pro");
  });

  it("does not warm a free account with no cached data for the requested group", () => {
    const manager = managerWith([
      proAccount("pro"),
      freeAccount("free", {
        cachedQuota: { claude: { remainingFraction: 1, modelCount: 1 } },
      }),
    ]);

    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "round-robin")?.parts.refreshToken).toBe("pro");
  });

  it("skips a free account that is rate limited for the requested model", () => {
    const manager = managerWith([
      proAccount("pro"),
      freeAccount("free", {
        // Zero remaining keeps load-time quota reconciliation from clearing the
        // marker, so this test isolates the rate-limit gate.
        cachedQuota: { "gemini-flash": { remainingFraction: 0, modelCount: 1 } },
        rateLimitResetTimes: { "gemini-antigravity:gemini-3.8-flash-high": Date.now() + 600_000 },
      }),
    ]);

    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3.8-flash-high", "round-robin")?.parts.refreshToken).toBe("pro");
  });

  it("honours eligible() so a free account without the model is not warmed", () => {
    const manager = managerWith([proAccount("pro"), freeAccount("free")]);

    const selected = manager.getCurrentOrNextForFamily(
      "gemini",
      "gemini-3.8-flash-high",
      "round-robin",
      "antigravity",
      false,
      100,
      600_000,
      account => account.parts.refreshToken === "pro",
    );

    expect(selected?.parts.refreshToken).toBe("pro");
  });

  it("can be disabled with free_account_first: false", () => {
    const manager = managerWith([proAccount("pro"), freeAccount("free")]);

    const selected = manager.getCurrentOrNextForFamily(
      "gemini",
      "gemini-3.8-flash-high",
      "round-robin",
      "antigravity",
      false,
      100,
      600_000,
      () => true,
      100,
      false,
    );

    expect(selected?.parts.refreshToken).toBe("pro");
  });
});
