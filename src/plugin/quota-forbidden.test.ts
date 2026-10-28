import { describe, expect, it } from "vitest"

import { __testExports } from "../plugin.ts"

const { buildQuotaExhaustedMessage, parseBodyInfoFromText } = __testExports

describe("buildQuotaExhaustedMessage", () => {
  it("names the quota, the model, the reset time and the exhausted pool", () => {
    const message = buildQuotaExhaustedMessage(
      {
        quotaName: "Antigravity",
        model: "gemini-3-flash",
        resetAt: "2026-10-28T09:00:00Z",
        detail: "Resource has been exhausted.",
      },
      2,
    )

    expect(message).toContain("Google quota exhausted for gemini-3-flash")
    expect(message).toContain("all 2 connected account(s)")
    expect(message).toContain("Antigravity quota")
    expect(message).toContain("Quota resets at 2026-10-28T09:00:00Z")
    expect(message).toContain("opencode auth login")
    expect(message).toContain("Provider message: Resource has been exhausted.")
  })

  it("omits the reset clause when Google did not report a reset time", () => {
    const message = buildQuotaExhaustedMessage({ quotaName: "Gemini CLI" }, 1)

    expect(message).toContain("all 1 connected account(s)")
    expect(message).not.toContain("Quota resets at")
    expect(message).not.toContain("Provider message:")
  })
})

describe("parseBodyInfoFromText", () => {
  it("reads the reason and retry delay from a Google error body", () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "Quota exceeded for quota metric",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RESOURCE_EXHAUSTED" },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "120s" },
        ],
      },
    })

    expect(parseBodyInfoFromText(body)).toMatchObject({
      retryDelayMs: 120_000,
      reason: "RESOURCE_EXHAUSTED",
      message: "Quota exceeded for quota metric",
    })
  })

  it("degrades to no retry delay for a body that is not JSON", () => {
    expect(parseBodyInfoFromText("<html>Forbidden</html>")).toEqual({ retryDelayMs: null })
    expect(parseBodyInfoFromText("")).toEqual({ retryDelayMs: null })
  })
})
