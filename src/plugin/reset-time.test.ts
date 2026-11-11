import { describe, expect, it } from "vitest"

import { formatResetStamp, formatTwoTierQuotaReport } from "./reset-time"

const now = new Date("2026-11-11T03:00:00Z").getTime()

describe("formatResetStamp", () => {
  it("returns empty for missing input", () => {
    expect(formatResetStamp(undefined)).toBe("")
    expect(formatResetStamp(null)).toBe("")
    expect(formatResetStamp("")).toBe("")
  })

  it("renders future days and hours in local time with countdown", () => {
    expect(
      formatResetStamp("2026-11-13T10:00:00Z", { now, timeZone: "Asia/Jakarta" }),
    ).toBe("13 Nov 17:00, in 2d 7h")
  })

  it("renders future hours and minutes in local time with countdown", () => {
    expect(
      formatResetStamp("2026-11-11T05:30:00Z", { now, timeZone: "Asia/Jakarta" }),
    ).toBe("11 Nov 12:30, in 2h 30m")
  })

  it("renders future minutes in local time with countdown", () => {
    expect(
      formatResetStamp("2026-11-11T03:45:00Z", { now, timeZone: "Asia/Jakarta" }),
    ).toBe("11 Nov 10:45, in 45m")
  })

  it("renders future seconds in local time with countdown", () => {
    expect(
      formatResetStamp("2026-11-11T03:00:30Z", { now, timeZone: "Asia/Jakarta" }),
    ).toBe("11 Nov 10:00, in 30s")
  })

  it("returns already resetting for past reset times", () => {
    expect(formatResetStamp("2026-11-11T02:00:00Z", { now })).toBe("already resetting")
  })

  it("passes unparsable input through unchanged", () => {
    expect(formatResetStamp("not-a-date", { now })).toBe("not-a-date")
  })
})

describe("formatTwoTierQuotaReport", () => {
  it("renders both 5h and 1w with remaining fractions and countdowns", () => {
    const shortQuota = { remainingFraction: 0.62, resetTime: "2026-11-11T05:30:00Z" }
    const weeklyQuota = { remainingFraction: 0.88, resetTime: "2026-11-18T09:42:00Z" }
    expect(
      formatTwoTierQuotaReport(shortQuota, weeklyQuota, { now, timeZone: "Asia/Jakarta" }),
    ).toBe("5h: 62% (resets 11 Nov 12:30, in 2h 30m) | 1w: 88% (resets 18 Nov 16:42, in 7d 6h)")
  })

  it("renders only 5h when weekly is not provided", () => {
    const shortQuota = { remainingFraction: 0.5, resetTime: "2026-11-11T05:30:00Z" }
    expect(
      formatTwoTierQuotaReport(shortQuota, undefined, { now, timeZone: "Asia/Jakarta" }),
    ).toBe("5h: 50% (resets 11 Nov 12:30, in 2h 30m)")
  })
})
