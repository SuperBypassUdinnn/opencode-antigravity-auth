import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountManager } from "./accounts.ts";
import { getHealthTracker, initHealthTracker, initTokenTracker } from "./rotation.ts";
import type { AccountStorageV4 } from "./storage.ts";

/**
 * The selection path skips accounts held back by the soft quota guard. If the
 * antigravity-first check keeps reporting such an account as available, every
 * round switches accounts without ever falling back to the other quota pool or
 * sending a request.
 */
function createManager(): AccountManager {
  const stored: AccountStorageV4 = {
    version: 4,
    accounts: [
      { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
      { refreshToken: "r2", projectId: "p2", addedAt: 1, lastUsed: 0 },
    ],
    activeIndex: 0,
  };
  return new AccountManager(undefined, stored);
}

describe("hasOtherAccountWithAntigravityAvailable soft quota", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("treats an account over the soft quota threshold as unavailable", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.markRateLimited(accounts[0]!, 60_000, "gemini", "antigravity");
    manager.updateQuotaCache(accounts[1]!.index, {
      "gemini-pro": { remainingFraction: 0.01, modelCount: 1 },
    });

    const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
      accounts[0]!.index,
      "gemini",
      null,
      () => true,
      90,
      60_000,
    );

    expect(hasOther).toBe(false);
  });

  it("keeps reporting an account that still has quota left", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.markRateLimited(accounts[0]!, 60_000, "gemini", "antigravity");
    manager.updateQuotaCache(accounts[1]!.index, {
      "gemini-pro": { remainingFraction: 0.5, modelCount: 1 },
    });

    const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
      accounts[0]!.index,
      "gemini",
      null,
      () => true,
      90,
      60_000,
    );

    expect(hasOther).toBe(true);
  });

  it("ignores the soft quota threshold when it is disabled", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.markRateLimited(accounts[0]!, 60_000, "gemini", "antigravity");
    manager.updateQuotaCache(accounts[1]!.index, {
      "gemini-pro": { remainingFraction: 0.01, modelCount: 1 },
    });

    const hasOther = manager.hasOtherAccountWithAntigravityAvailable(
      accounts[0]!.index,
      "gemini",
      null,
      () => true,
      100,
      60_000,
    );

    expect(hasOther).toBe(true);
  });
});

/**
 * The selection guard picks between "wait for the real reset" and "no reset
 * exists, report the threshold" from getMinWaitTimeForFamily. That helper
 * answers 0 whenever any account still holds quota in either pool, which is
 * exactly why the earlier code invented a one-minute reset.
 */
describe("getMinWaitTimeForFamily with a soft-quota-blocked pool", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reports no wait while the alternate pool still has quota", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.markRateLimited(accounts[0]!, 3_600_000, "gemini", "antigravity");
    manager.markRateLimited(accounts[1]!, 3_600_000, "gemini", "antigravity");
    manager.updateQuotaCache(accounts[1]!.index, {
      "gemini-pro": { remainingFraction: 0.01, modelCount: 1 },
    });

    const waitMs = manager.getMinWaitTimeForFamily("gemini", null, "antigravity", false);

    expect(waitMs).toBe(0);
  });

  it("reports the real reset once every pool is rate-limited", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.markRateLimited(accounts[0]!, 3_600_000, "gemini", "antigravity");
    manager.markRateLimited(accounts[1]!, 3_600_000, "gemini", "antigravity");
    manager.markRateLimited(accounts[0]!, 3_600_000, "gemini", "gemini-cli");
    manager.markRateLimited(accounts[1]!, 3_600_000, "gemini", "gemini-cli");

    const waitMs = manager.getMinWaitTimeForFamily("gemini", null, "antigravity", false);

    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThanOrEqual(3_600_000);
  });
});

/**
 * The wait query must see every blocker the selection path sees. Cooldowns,
 * base-key rate-limit marks, and the soft quota cache previously stayed
 * invisible, so the guard computed 0 ms, read that as "no usable candidate",
 * and aborted requests that a short wait would have served.
 */
describe("getMinWaitTimeForFamily sees every transient blocker", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("counts a cooling-down account as blocked instead of reporting 0", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    for (const account of accounts) {
      manager.markAccountCoolingDown(account!, 30_000, "network-error");
    }

    const waitMs = manager.getMinWaitTimeForFamily("gemini", null, "antigravity", false);

    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThanOrEqual(30_000);
  });

  it("sees base-key rate-limit marks that the model-key scan missed", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    // markRateLimited without a model writes the BASE antigravity key, which
    // the old strict wait query never read while the skip logic honored it.
    manager.markRateLimited(accounts[0]!, 30_000, "gemini", "antigravity");
    manager.markRateLimited(accounts[1]!, 30_000, "gemini", "antigravity");

    const waitMs = manager.getMinWaitTimeForFamily("gemini", "gemini-3-pro", "antigravity", true);

    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThanOrEqual(30_000);
  });

  it("waits for the soft quota reset instead of reporting 0", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    const resetTime = new Date(Date.now() + 5 * 60_000).toISOString();
    for (const account of accounts) {
      manager.updateQuotaCache(account!.index, {
        "gemini-pro": { remainingFraction: 0.01, modelCount: 1, resetTime },
      });
    }

    const waitMs = manager.getMinWaitTimeForFamily(
      "gemini",
      "gemini-3-pro",
      "antigravity",
      false,
      () => true,
      90,
      30 * 60_000,
    );

    expect(waitMs).toBeGreaterThan(4 * 60_000);
    expect(waitMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it("reports a bounded wait when a soft-quota-blocked account has no reset time", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    for (const account of accounts) {
      manager.updateQuotaCache(account!.index, {
        "gemini-pro": { remainingFraction: 0.01, modelCount: 1 },
      });
    }

    const waitMs = manager.getMinWaitTimeForFamily(
      "gemini",
      "gemini-3-pro",
      "antigravity",
      false,
      () => true,
      90,
      30 * 60_000,
    );

    expect(waitMs).toBe(60_000);
  });
});

/**
 * The soft quota decision must read the requested model's own quota entry
 * instead of the group minimum, so one depleted sibling model no longer
 * blocks a model that still has quota.
 */
describe("per-model soft quota decision", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("does not block the requested model when its own quota is healthy", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.updateQuotaCache(accounts[0]!.index, {
      "gemini-flash": {
        remainingFraction: 0.05,
        modelCount: 2,
        models: { "gemini-3.8-flash": { remainingFraction: 0.5 } },
      },
    });

    const selected = manager.getNextForFamily(
      "gemini",
      "antigravity-gemini-3.8-flash",
      "antigravity",
      90,
      30 * 60_000,
    );

    expect(selected?.index).toBe(0);
  });

  it("still blocks a model with no own entry when the group minimum is exhausted", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    for (const account of accounts) {
      manager.updateQuotaCache(account!.index, {
        "gemini-flash": {
          remainingFraction: 0.05,
          modelCount: 2,
          models: { "gemini-3.8-flash": { remainingFraction: 0.5 } },
        },
      });
    }

    const selected = manager.getNextForFamily(
      "gemini",
      "gemini-3.9-flash",
      "antigravity",
      90,
      30 * 60_000,
    );

    expect(selected).toBeNull();
  });
});

/**
 * The fatal "No account can serve" error must name the real per-account
 * blockers instead of blaming the soft quota threshold for everything.
 */
describe("describeAccountBlockers", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("names rate limits, cooldowns, and soft quota per account", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.markRateLimited(accounts[0]!, 30_000, "gemini", "antigravity");
    manager.markAccountCoolingDown(accounts[1]!, 30_000, "validation-required");
    manager.updateQuotaCache(accounts[1]!.index, {
      "gemini-flash": { remainingFraction: 0.05, modelCount: 1 },
    });

    const lines = manager.describeAccountBlockers(
      "gemini",
      "gemini-3.8-flash",
      "antigravity",
      true,
      () => true,
      90,
      30 * 60_000,
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("antigravity pool rate-limited");
    expect(lines[0]).toContain("resets in");
    expect(lines[1]).toContain("cooling down after validation-required");
    expect(lines[1]).toContain("over the 90% soft quota threshold");
    expect(lines[1]).toContain("used 95.0%");
  });

  it("omits accounts that are not blocked", () => {
    const manager = createManager();
    const lines = manager.describeAccountBlockers(
      "gemini",
      null,
      "antigravity",
      false,
      () => true,
      90,
      30 * 60_000,
    );
    expect(lines).toEqual([]);
  });
});

/**
 * Hybrid selection also gates accounts by health score. When every account is
 * health-gated, the wait query and the fatal error message must say so instead
 * of reporting "0 ms, nothing blocked" and aborting the request.
 */
describe("health gate visibility", () => {
  beforeEach(() => {
    vi.useRealTimers();
    initHealthTracker({});
  });

  it("waits for health recovery instead of reporting 0", () => {
    const manager = createManager();
    const tracker = getHealthTracker();
    for (const account of manager.getAccounts()) {
      tracker.recordFailure(account!.index);
      tracker.recordFailure(account!.index);
    }

    // 70 - 20 * 2 = 30; recovering to minUsable 50 at 2 points/hour = 10h.
    const waitMs = manager.getMinWaitTimeForFamily(
      "gemini",
      "gemini-3.8-flash",
      "antigravity",
      false,
      () => true,
      90,
      30 * 60_000,
    );

    expect(waitMs).toBe(36_000_000);
  });

  it("names health-gated accounts in the blocker breakdown", () => {
    const manager = createManager();
    const tracker = getHealthTracker();
    for (const account of manager.getAccounts()) {
      tracker.recordFailure(account!.index);
      tracker.recordFailure(account!.index);
    }

    const lines = manager.describeAccountBlockers(
      "gemini",
      "gemini-3.8-flash",
      "antigravity",
      true,
      () => true,
      90,
      30 * 60_000,
    );

    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("health score too low after failures (30/100, min 50)");
  });
});

/**
 * Hybrid metrics must use the same per-pool rate-limit check as the per-round
 * skip logic. The old both-pools check selected accounts carrying only an
 * antigravity-pool mark, which the round loop then skipped — burning rounds
 * without ever sending a request (the account #24 incident).
 */
describe("hybrid selection per-pool rate-limit check", () => {
  beforeEach(() => {
    vi.useRealTimers();
    initHealthTracker({});
    initTokenTracker({});
  });

  it("selects nothing when every account is marked for the requested pool", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.markRateLimited(accounts[0]!, 60_000, "gemini", "antigravity");
    manager.markRateLimited(accounts[1]!, 60_000, "gemini", "antigravity");

    const selected = manager.getCurrentOrNextForFamily(
      "gemini",
      "gemini-3.8-flash",
      "hybrid",
      "antigravity",
      false,
      90,
      30 * 60_000,
    );

    expect(selected).toBeNull();
  });

  it("skips the marked account and selects the clean one", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    manager.markRateLimited(accounts[0]!, 60_000, "gemini", "antigravity");

    const selected = manager.getCurrentOrNextForFamily(
      "gemini",
      "gemini-3.8-flash",
      "hybrid",
      "antigravity",
      false,
      90,
      30 * 60_000,
    );

    expect(selected?.index).toBe(1);
  });
});

/**
 * The backend cache stores tier-suffixed model names (gemini-3.8-flash-high
 * and friends), so a bare request like antigravity-gemini-3.8-flash must
 * find its tier variants before falling back to the group minimum.
 */
describe("quota candidates match tier-suffixed cache keys", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("reads the tier-suffixed entry for a bare request instead of the group minimum", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    for (const account of accounts) {
      manager.updateQuotaCache(account!.index, {
        "gemini-flash": {
          remainingFraction: 0.05,
          modelCount: 2,
          models: { "gemini-3.8-flash-high": { remainingFraction: 0.5 } },
        },
      });
    }

    const selected = manager.getNextForFamily(
      "gemini",
      "antigravity-gemini-3.8-flash",
      "antigravity",
      90,
      30 * 60_000,
    );

    expect(selected?.index).toBe(0);
  });

  it("prefers the request's own tier when the cache carries several tiers", () => {
    const manager = createManager();
    const accounts = manager.getAccounts();
    for (const account of accounts) {
      manager.updateQuotaCache(account!.index, {
        "gemini-flash": {
          remainingFraction: 0.05,
          modelCount: 3,
          models: {
            "gemini-3.8-flash-high": { remainingFraction: 0.5 },
            "gemini-3.8-flash-low": { remainingFraction: 0.02 },
          },
        },
      });
    }

    const selected = manager.getNextForFamily(
      "gemini",
      "antigravity-gemini-3.8-flash-low",
      "antigravity",
      90,
      30 * 60_000,
    );

    expect(selected).toBeNull();
  });
});
