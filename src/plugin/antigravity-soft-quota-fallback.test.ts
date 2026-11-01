import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountManager } from "./accounts.ts";
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
