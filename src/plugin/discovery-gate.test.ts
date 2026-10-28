import { describe, expect, it } from "vitest"

import { createDiscoveryGate } from "./discovery-gate.ts"

function setup(options: { staleMs?: number } = {}) {
  let clock = 1_000_000
  const gate = createDiscoveryGate({
    now: () => clock,
    staleMs: options.staleMs ?? 10 * 60_000,
  })
  return {
    gate,
    /** Advances the fake clock and returns the new time. */
    advance(ms: number) {
      clock += ms
      return clock
    },
  }
}

describe("createDiscoveryGate", () => {
  it("lets one sweep hold the gate", () => {
    const { gate } = setup()

    expect(gate.tryStart()).toBeDefined()
    expect(gate.running).toBe(true)
    expect(gate.tryStart()).toBeUndefined()
  })

  it("frees the gate when the holder releases", () => {
    const { gate } = setup()
    const first = gate.tryStart()
    expect(first).toBeDefined()

    gate.finish(first!)
    expect(gate.running).toBe(false)
    expect(gate.tryStart()).toBeDefined()
  })

  it("replaces a sweep that outlived the stale limit", () => {
    const { gate, advance } = setup({ staleMs: 60_000 })

    expect(gate.tryStart()).toBeDefined()
    advance(60_000)

    expect(gate.tryStart()).toBeDefined()
    expect(gate.running).toBe(true)
  })

  it("ignores a release from a replaced sweep", () => {
    const { gate, advance } = setup({ staleMs: 60_000 })
    const stale = gate.tryStart()
    expect(stale).toBeDefined()

    advance(60_000)
    const replacement = gate.tryStart()
    expect(replacement).toBeDefined()

    gate.finish(stale!)
    expect(gate.running).toBe(true)

    gate.finish(replacement!)
    expect(gate.running).toBe(false)
  })

  it("drops ownership on reset", () => {
    const { gate } = setup()
    expect(gate.tryStart()).toBeDefined()

    gate.reset()
    expect(gate.running).toBe(false)
    expect(gate.tryStart()).toBeDefined()
  })
})
