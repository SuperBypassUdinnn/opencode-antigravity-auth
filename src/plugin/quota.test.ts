import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./token", () => ({
  refreshAccessToken: vi.fn(async (auth: { refresh: string }) => ({
    type: "oauth",
    refresh: auth.refresh,
    access: "access-token",
    expires: Date.now() + 3_600_000,
  })),
}))

import { GEMINI_CLI_HEADERS, getAntigravityUserAgent } from "../constants.ts"
import { aggregateQuota, checkAccountsQuota, isProQuotaGroup } from "./quota.ts"
import { refreshAccessToken } from "./token.ts"
import type { AccountMetadataV3 } from "./storage.ts"
import type { PluginClient } from "./types.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const account: AccountMetadataV3 = {
  email: "user@example.com",
  refreshToken: "refresh-token",
  managedProjectId: "managed-project",
  addedAt: 0,
  lastUsed: 0,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("checkAccountsQuota", () => {
  it("persists OAuth rotation before catalog I/O starts", async () => {
    vi.mocked(refreshAccessToken).mockResolvedValueOnce({ type: "oauth", refresh: "rotated||managed-project", access: "fresh", expires: Date.now() + 3600_000 })
    let persisted = false
    const save = vi.fn(async () => { persisted = true })
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(persisted).toBe(true)
      if (String(input).endsWith(":fetchAvailableModels")) return jsonResponse({ models: {} })
      return jsonResponse({ buckets: [] })
    }))
    await checkAccountsQuota([account], {} as PluginClient, "google", { onAccountUpdated: save })
    expect(save).toHaveBeenCalledWith(account, expect.objectContaining({ refreshToken: "rotated" }))
  })

  it("skips disabled accounts without refreshing their tokens when requested", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const results = await checkAccountsQuota([{ ...account, enabled: false }], {} as PluginClient, "google", { includeDisabled: false })
    expect(results).toEqual([{ index: 0, email: account.email, status: "disabled", disabled: true }])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reads Antigravity quota from the daily host with the Hub User-Agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/v1internal:fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "claude-opus-5-5-high": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-22T00:00:00Z" } },
            "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 0.25 } },
            "gemini-4-argon-high": { maxTokens: 1048576, quotaInfo: { remainingFraction: 0.75 } },
            "gemini-4-argon-disabled": { disabled: true, quotaInfo: { remainingFraction: 0 } },
            "malformed-entry": null,
          },
        })
      }
      if (url.endsWith("/v1internal:retrieveUserQuota")) {
        return jsonResponse({ buckets: [] })
      }
      return jsonResponse({ error: "unexpected" }, 404)
    })
    vi.stubGlobal("fetch", fetchMock)

    const [result] = await checkAccountsQuota([account], {} as PluginClient)

    expect(result?.status).toBe("ok")
    expect(result?.quota?.groups.claude?.remainingFraction).toBe(0.5)
    expect(result?.quota?.groups.gemini?.remainingFraction).toBe(0.25)
    expect((result?.quota?.groups as Record<string, unknown>)["gemini-pro"]).toBeUndefined()
    expect((result?.quota?.groups as Record<string, unknown>)["gemini-flash"]).toBeUndefined()
    expect((result?.quota?.groups as Record<string, unknown>)["gemini-argon"]).toBeUndefined()
    expect(result?.quota?.models?.["gemini-4-argon-high"]?.maxTokens).toBe(1048576)

    const modelsCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/v1internal:fetchAvailableModels"))
    expect(modelsCalls).toHaveLength(1)
    const [modelsUrl, modelsInit] = modelsCalls[0]!
    expect(String(modelsUrl)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
    expect(new Headers(modelsInit?.headers).get("User-Agent")).toBe(getAntigravityUserAgent())
    expect(JSON.parse(String(modelsInit?.body))).toEqual({ project: "managed-project" })

    // Gemini CLI quota buckets stay on production.
    const cliCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1internal:retrieveUserQuota"))
    expect(String(cliCall?.[0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
    expect(new Headers(cliCall?.[1]?.headers).get("User-Agent")).toBe(GEMINI_CLI_HEADERS["User-Agent"])
  })

  it("syncs unified gemini 5h and weekly windows from retrieveUserQuotaSummary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/v1internal:fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-4-carbon-high": {
              displayName: "Gemini 4 Carbon (High)",
              quotaInfo: { remainingFraction: 0.9, resetTime: "2030-01-08T00:00:00Z" },
            },
            "gemini-4-argon-high": {
              displayName: "Gemini 4 Argon (High)",
              quotaInfo: { remainingFraction: 0.9, resetTime: "2030-01-08T00:00:00Z" },
            },
            "gemini-flash-worker-agy": {
              displayName: "Gemini 4 Hydrogen (Orchestrator)",
              selectable: false,
              quotaInfo: { remainingFraction: 0.97, resetTime: "2030-01-01T05:00:00Z" },
            },
          },
        })
      }
      if (url.endsWith("/v1internal:retrieveUserQuotaSummary")) {
        return jsonResponse({
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                { window: "5h", remainingFraction: 0.72, resetTime: "2030-01-01T05:00:00Z" },
                { window: "weekly", remainingFraction: 0.88, resetTime: "2030-01-08T12:00:00Z" },
              ],
            },
          ],
        })
      }
      return jsonResponse({ buckets: [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    const [result] = await checkAccountsQuota([account], {} as PluginClient)

    expect(result?.quota?.groups.gemini).toMatchObject({
      remainingFraction: 0.72,
      resetTime: "2030-01-01T05:00:00Z",
      weeklyRemainingFraction: 0.88,
      weeklyResetTime: "2030-01-08T12:00:00Z",
    })
    expect((result?.quota?.groups as Record<string, unknown>)["gemini-argon"]).toBeUndefined()
  })

  it("shows current Gemini CLI model versions returned by Google", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(":fetchAvailableModels")) return jsonResponse({ models: {} })
      return jsonResponse({ buckets: [
        { modelId: "gemini-3.8-flash-high", remainingFraction: 0.42, resetTime: "2026-10-22T00:00:00Z" },
        { modelId: "gemini-3.5-flash-lite", remainingFraction: 0.8 },
        { modelId: "gemini-4-pro", remainingFraction: 0.6 },
        { modelId: "unrelated-model", remainingFraction: 1 },
      ] })
    }))
    const [result] = await checkAccountsQuota([account], {} as PluginClient)
    expect(result?.geminiCliQuota?.models.map(model => model.modelId)).toEqual([
      "gemini-3.5-flash-lite", "gemini-3.8-flash-high", "gemini-4-pro",
    ])
    expect(result?.geminiCliQuota?.models[1]).toMatchObject({ remainingFraction: 0.42, resetTime: "2026-10-22T00:00:00Z" })
  })

  it("stops the sweep once its budget is spent", async () => {
    let clock = 1_000_000
    const nowMock = vi.spyOn(Date, "now").mockImplementation(() => clock)
    try {
      vi.stubGlobal("fetch", vi.fn(async () => {
        clock += 25_000
        return jsonResponse({ models: {} })
      }))
      const accounts: AccountMetadataV3[] = [
        { ...account, email: "first@example.com" },
        { ...account, email: "second@example.com" },
      ]

      const results = await checkAccountsQuota(accounts, {} as PluginClient, undefined, { concurrency: 1 })

      expect(results[0]?.status).toBe("ok")
      expect(results[1]).toMatchObject({ index: 1, status: "error" })
      expect(results[1]?.error).toMatch(/budget/i)
    } finally {
      nowMock.mockRestore()
    }
  })

  it("processes accounts concurrently with default pool", async () => {
    let running = 0
    let maxRunning = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      running++
      if (running > maxRunning) maxRunning = running
      await new Promise(resolve => setTimeout(resolve, 10))
      running--
      return jsonResponse({ models: {} })
    }))

    const accounts: AccountMetadataV3[] = Array.from({ length: 8 }, (_, i) => ({
      ...account,
      email: `user${i}@example.com`,
    }))

    const results = await checkAccountsQuota(accounts, {} as PluginClient)
    expect(results).toHaveLength(8)
    expect(results.every(r => r.status === "ok")).toBe(true)
    expect(maxRunning).toBeGreaterThanOrEqual(2)
  })
})

describe("aggregateQuota per-model entries", () => {
  it("records each model's own quota next to the group minimum", () => {
    const models = {
      "gemini-3.8-flash": { quotaInfo: { remainingFraction: 0.5, resetTime: "2030-01-01T00:00:00Z" } },
      "gemini-4-hydrogen-high": { quotaInfo: { remainingFraction: 0.05 } },
    } as Parameters<typeof aggregateQuota>[0];

    const summary = aggregateQuota(models);

    const gemini = summary.groups.gemini;
    expect(gemini?.remainingFraction).toBe(0.05);
    expect(gemini?.models?.["gemini-3.8-flash"]?.remainingFraction).toBe(0.5);
    expect(gemini?.models?.["gemini-3.8-flash"]?.resetTime).toBe("2030-01-01T00:00:00Z");
    expect(gemini?.models?.["gemini-4-hydrogen-high"]?.remainingFraction).toBe(0.05);
    expect(gemini?.models?.["gemini-4-hydrogen-high"]?.resetTime).toBeUndefined();
  });

  it("keeps a quota-less model's entry without a remaining fraction", () => {
    const models = {
      "gemini-3.8-flash": { quotaInfo: { remainingFraction: 0.4 } },
      "gemini-4-hydrogen-high": {},
    } as Parameters<typeof aggregateQuota>[0];

    const summary = aggregateQuota(models);

    const gemini = summary.groups.gemini;
    expect(gemini?.remainingFraction).toBe(0.4);
    expect(gemini?.models?.["gemini-4-hydrogen-high"]?.remainingFraction).toBeUndefined();
    expect(gemini?.models?.["gemini-3.8-flash"]?.remainingFraction).toBe(0.4);
  });

  it("aggregates all Gemini models (including argon, carbon, hydrogen, and orchestrators) into unified gemini", () => {
    const models = {
      "gemini-4-argon-high": { quotaInfo: { remainingFraction: 0.25, resetTime: "2030-01-05T00:00:00Z" } },
      "gemini-4-carbon-high": { quotaInfo: { remainingFraction: 0.72, resetTime: "2030-01-01T05:00:00Z" } },
      "gemini-pro-orchestrator-g1-pro": { quotaInfo: { remainingFraction: 0.3 } },
      "gemini-4-hydrogen-high": { quotaInfo: { remainingFraction: 0.9 } },
    } as Parameters<typeof aggregateQuota>[0];

    const summary = aggregateQuota(models);

    const gemini = summary.groups.gemini;
    expect(gemini?.remainingFraction).toBe(0.25);
    expect(gemini?.models?.["gemini-4-argon-high"]?.resetTime).toBe("2030-01-05T00:00:00Z");
    expect(gemini?.models?.["gemini-4-carbon-high"]?.remainingFraction).toBe(0.72);
    expect(gemini?.models?.["gemini-pro-orchestrator-g1-pro"]?.remainingFraction).toBe(0.3);
    expect(gemini?.models?.["gemini-4-hydrogen-high"]?.remainingFraction).toBe(0.9);
  });

  it("identifies Pro accounts from Pro-tier models while ignoring free-account internal sonar models", () => {
    expect(isProQuotaGroup({
      gemini: { modelCount: 1, models: { "gemini-4-carbon-high": { remainingFraction: 1 } } },
    })).toBe(true);
    expect(isProQuotaGroup({
      claude: { modelCount: 1, models: { "claude-opus-5-5-high": { remainingFraction: 1 } } },
    })).toBe(true);
    expect(isProQuotaGroup({
      gemini: { modelCount: 2, models: { "gemini-3.8-flash-high": { remainingFraction: 1 }, "gemini-4-hydrogen-sonar": { remainingFraction: 1 } } },
    })).toBe(false);
  });
});
