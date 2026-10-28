/**
 * Process-wide ownership for Antigravity model discovery.
 *
 * A sweep refreshes the OAuth credential of every saved account before it reads
 * their model catalogs. Each write emits `credential.updated`, and that event
 * reloads providers, which re-enters plugin setup. Without coordination the new
 * setup starts another sweep and the cycle never settles, which is what made the
 * client unresponsive on a model switch.
 *
 * The gate lets exactly one sweep own the process at a time. A sweep that runs
 * past the stale limit is assumed dead and may be replaced, so a hung request can
 * never block discovery for the lifetime of the client.
 */

/** A sweep older than this is assumed dead and may be replaced. */
export const DISCOVERY_STALE_MS = 10 * 60_000

/**
 * Minimum spacing between automatic sweeps. A sweep refreshes every saved
 * account, so a reload loop must not be able to start one per reload.
 */
export const DISCOVERY_MIN_INTERVAL_MS = 60 * 60_000

export interface DiscoveryLease {
  readonly id: number
}

export interface DiscoveryGate {
  /** True while a sweep holds the gate. */
  readonly running: boolean
  /** Returns a lease when the caller may sweep, and `undefined` when it may not. */
  tryStart(): DiscoveryLease | undefined
  /** Releases a lease. A lease replaced as stale cannot release its successor. */
  finish(lease: DiscoveryLease): void
  /** Drops ownership without waiting. Tests use it to isolate process-wide state. */
  reset(): void
}

export interface DiscoveryGateOptions {
  now?: () => number
  staleMs?: number
}

export function createDiscoveryGate(options: DiscoveryGateOptions = {}): DiscoveryGate {
  const now = options.now ?? Date.now
  const staleMs = options.staleMs ?? DISCOVERY_STALE_MS
  let held: { lease: DiscoveryLease; startedAt: number } | undefined
  let sequence = 0

  return {
    get running() {
      return held !== undefined
    },
    tryStart() {
      const at = now()
      if (held && at - held.startedAt < staleMs) return undefined
      // A stale sweep keeps running but loses ownership, so its eventual
      // `finish` cannot release the sweep that replaced it.
      sequence += 1
      held = { lease: { id: sequence }, startedAt: at }
      return held.lease
    },
    finish(lease) {
      if (held?.lease.id === lease.id) held = undefined
    },
    reset() {
      held = undefined
    },
  }
}

/** Shared by every plugin setup in this process. */
export const discoveryGate = createDiscoveryGate()
