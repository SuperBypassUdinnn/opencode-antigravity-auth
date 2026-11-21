import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import { AntigravityAccountsRpc } from "./account-rpc.ts"
import { accountID, registerAccountManagement } from "./account-management.ts"
import type { AccountStorageV4 } from "./storage.ts"
import type { PluginClient } from "./types.ts"
import { checkAccountsQuota } from "./quota.ts"

vi.mock("./quota.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./quota.ts")>(),
  checkAccountsQuota: vi.fn(),
}))

const state = vi.hoisted(() => ({ storage: undefined as AccountStorageV4 | undefined, beforeUpdate: undefined as (() => void) | undefined }))
vi.mock("./storage.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./storage.ts")>(),
  loadAccounts: async () => structuredClone(state.storage),
  updateAccounts: async (update: (storage: AccountStorageV4) => void) => {
    state.beforeUpdate?.()
    if (!state.storage) return null
    const storage = structuredClone(state.storage)
    update(storage)
    state.storage = storage
    return storage
  },
  saveAccounts: async (value: AccountStorageV4) => { state.storage = structuredClone(value) },
  saveAccountsReplace: async (value: AccountStorageV4) => { state.storage = structuredClone(value) },
}))

beforeEach(() => {
  state.beforeUpdate = undefined
  state.storage = {
    version: 4, activeIndex: 1, activeIndexByFamily: { claude: 1, gemini: 2 },
    accounts: ["first", "second", "third"].map(name => ({ email: `${name}@example.test`, refreshToken: `${name}-secret`, addedAt: 1, lastUsed: 2 })),
  }
})

async function host(rotate = false) {
  let handlers: RpcHandlers<typeof AntigravityAccountsRpc> | undefined
  const beforeWrite = vi.fn(async () => undefined)
  const ctx = {
    rpc: { register: async (_definition: unknown, value: RpcHandlers<typeof AntigravityAccountsRpc>) => {
      handlers = value
      return { dispose: async () => undefined, events: { emit: async () => undefined } }
    } },
    integration: {
      get: async () => ({ data: { connections: [{ type: "credential", id: "native-first", method: "oauth" }] } }),
      connection: { active: async () => undefined, resolve: async () => {
        if (rotate) state.storage!.accounts[0]!.refreshToken = "rotated-secret"
        return { type: "oauth", refresh: `${rotate ? "rotated-secret" : "first-secret"}|project` }
      } },
    },
    storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    credential: { activate: vi.fn(async () => undefined) },
  } as unknown as Plugin.Context
  await registerAccountManagement(ctx, {} as PluginClient, beforeWrite, async () => 7)
  if (!handlers) throw new Error("Account RPC was not registered")
  return { handlers, beforeWrite }
}

const callContext = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }

describe("account management", () => {
  it("lists all accounts and associated native credentials without exposing OAuth tokens", async () => {
    const { handlers } = await host()
    const accounts = await handlers.list({}, callContext)
    expect(accounts).toHaveLength(3)
    expect(await handlers.connections({ id: accounts[0]!.id }, callContext)).toEqual({ ids: ["native-first"] })
    expect(accounts[1]?.current).toBe(true)
    expect(JSON.stringify(accounts)).not.toContain("secret")
  })

  it("flushes the manager before disabling an account and moves selection to an enabled account", async () => {
    const { handlers, beforeWrite } = await host()
    const id = accountID(state.storage!.accounts[1]!)
    await handlers.update({ id, action: "disable" }, callContext)
    expect(beforeWrite).toHaveBeenCalledOnce()
    expect(state.storage?.accounts[1]?.enabled).toBe(false)
    expect(state.storage?.activeIndex).toBe(0)
    await expect(handlers.update({ id, action: "select" }, callContext)).rejects.toThrow("Enable this account")
  })

  it("deletes by stable account identity and keeps family cursors on their original accounts", async () => {
    const { handlers } = await host()
    await handlers.update({ id: accountID(state.storage!.accounts[0]!), action: "delete" }, callContext)
    expect(state.storage?.accounts.map(account => account.email)).toEqual(["second@example.test", "third@example.test"])
    expect(state.storage?.activeIndex).toBe(0)
    expect(state.storage?.activeIndexByFamily).toEqual({ claude: 0, gemini: 1 })
  })

  it("keeps selection and deletion identities stable when native resolution rotates a token", async () => {
    const { handlers } = await host(true)
    const [account] = await handlers.list({}, callContext)
    const id = account!.id
    await handlers.update({ id, action: "select" }, callContext)
    expect(state.storage?.activeIndex).toBe(0)
    expect(state.storage?.accounts[0]?.refreshToken).toBe("rotated-secret")
    expect(await handlers.connections({ id }, callContext)).toEqual({ ids: ["native-first"] })
    await handlers.update({ id, action: "delete" }, callContext)
    expect(state.storage?.accounts).toHaveLength(2)
    expect(state.storage?.accounts.some(item => item.id === id)).toBe(false)
  })

  it("preserves a concurrent disable when a quota check updates project metadata", async () => {
    const { handlers } = await host()
    const [account] = await handlers.list({}, callContext)
    vi.mocked(checkAccountsQuota).mockImplementationOnce(async accounts => {
      const original = accounts[0]!
      state.storage!.accounts[0]!.enabled = false
      return [{ index: 0, status: "ok", updatedAccount: { ...original, managedProjectId: "discovered-project" } }]
    })
    await handlers.quotas({ id: account!.id }, callContext)
    expect(state.storage?.accounts[0]).toMatchObject({ enabled: false, managedProjectId: "discovered-project" })
  })

  it.each(["disable", "delete"] as const)("preserves a %s committed immediately before quota metadata acquires the storage lock", async action => {
    const { handlers } = await host()
    const [account] = await handlers.list({}, callContext)
    vi.mocked(checkAccountsQuota).mockImplementationOnce(async accounts => [{ index: 0, status: "ok", updatedAccount: { ...accounts[0]!, managedProjectId: "discovered-project" } }])
    state.beforeUpdate = () => {
      state.beforeUpdate = undefined
      if (action === "disable") state.storage!.accounts[0]!.enabled = false
      else state.storage!.accounts.shift()
    }
    await handlers.quotas({ id: account!.id }, callContext)
    if (action === "disable") expect(state.storage!.accounts[0]!.enabled).toBe(false)
    else expect(state.storage!.accounts.some(item => item.id === account!.id)).toBe(false)
  })

  it("renders gemini-argon with its weekly fraction and reset stamp", async () => {
    const { handlers } = await host()
    const [account] = await handlers.list({}, callContext)
    const fiveHour = new Date(Date.now() + 2 * 3600_000).toISOString()
    const weekly = new Date(Date.now() + 5 * 86400_000).toISOString()
    vi.mocked(checkAccountsQuota).mockImplementationOnce(async () => [{
      index: 0,
      status: "ok",
      quota: {
        modelCount: 2,
        groups: {
          "gemini-flash": { remainingFraction: 0.9, resetTime: fiveHour, modelCount: 1 },
          "gemini-argon": {
            remainingFraction: 0.5,
            resetTime: fiveHour,
            weeklyRemainingFraction: 0.85,
            weeklyResetTime: weekly,
            modelCount: 1,
          },
        },
      },
    }])

    const result = await handlers.quotas({ id: account!.id }, callContext)
    const argonLine = result.report.split("\n").find(line => line.includes("Antigravity gemini-argon:"))
    expect(argonLine).toContain("85% remaining")
    expect(argonLine).toMatch(/in [45]d /)
  })

  it("renders bucket groups in a fixed, stable order", async () => {
    const { handlers } = await host()
    const [account] = await handlers.list({}, callContext)
    const reset = new Date(Date.now() + 3600_000).toISOString()
    vi.mocked(checkAccountsQuota).mockImplementationOnce(async () => [{
      index: 0,
      status: "ok",
      quota: {
        modelCount: 3,
        groups: {
          "gemini-argon": { remainingFraction: 0.7, resetTime: reset, modelCount: 1 },
          "gemini-flash": { remainingFraction: 0.8, resetTime: reset, modelCount: 1 },
          claude: { remainingFraction: 0.9, resetTime: reset, modelCount: 1 },
        },
      },
    }])

    const result = await handlers.quotas({ id: account!.id }, callContext)
    const lines = result.report.split("\n").filter(line => line.includes("Antigravity "))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("Antigravity claude:")
    expect(lines[1]).toContain("Antigravity gemini-flash:")
    expect(lines[2]).toContain("Antigravity gemini-argon:")
  })
})

describe("account management clearLimits", () => {
  it("clears rate-limit markers on a single account and flushes before and after", async () => {
    const { handlers, beforeWrite } = await host()
    const target = state.storage!.accounts[1]!
    target.rateLimitResetTimes = { claude: Date.now() + 3600_000, "gemini-antigravity:antigravity-gemini-3.8-flash": Date.now() + 7200_000 }
    target.coolingDownUntil = Date.now() + 5000
    state.storage!.accounts[2]!.rateLimitResetTimes = { claude: Date.now() + 3600_000 }

    const result = await handlers.clearLimits({ id: accountID(target) }, callContext)

    expect(result.cleared).toBe(1)
    expect(state.storage?.accounts[1]?.rateLimitResetTimes).toEqual({})
    expect(state.storage?.accounts[1]?.coolingDownUntil).toBeUndefined()
    // Untouched account keeps its markers
    expect(Object.keys(state.storage?.accounts[2]?.rateLimitResetTimes ?? {})).toHaveLength(1)
    // Flush both before reading and after clearing
    expect(beforeWrite).toHaveBeenCalledTimes(2)
  })

  it("clears every enabled account when no id is given and skips disabled ones", async () => {
    const { handlers } = await host()
    state.storage!.accounts[0]!.rateLimitResetTimes = { claude: Date.now() + 3600_000 }
    state.storage!.accounts[1]!.rateLimitResetTimes = { claude: Date.now() + 3600_000 }
    state.storage!.accounts[2]!.enabled = false
    state.storage!.accounts[2]!.rateLimitResetTimes = { claude: Date.now() + 3600_000 }

    const result = await handlers.clearLimits({}, callContext)

    expect(result.cleared).toBe(2)
    expect(state.storage?.accounts[0]?.rateLimitResetTimes).toEqual({})
    expect(state.storage?.accounts[1]?.rateLimitResetTimes).toEqual({})
    expect(Object.keys(state.storage?.accounts[2]?.rateLimitResetTimes ?? {})).toHaveLength(1)
  })

  it("reports zero cleared when no account carries markers", async () => {
    const { handlers } = await host()
    const result = await handlers.clearLimits({}, callContext)
    expect(result.cleared).toBe(0)
    expect(result.message).toMatch(/No rate-limit markers/)
  })
})
