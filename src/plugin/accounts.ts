import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts, updateAccountCredentials, updateAccounts, type AccountStorageV4, type AccountMetadataV3, type RateLimitStateV3, type ModelFamily, type HeaderStyle, type CooldownReason } from "./storage";
import type { OAuthAuthDetails, RefreshParts } from "./types";
import type { AccountSelectionStrategy } from "./config/schema";
import { getHealthTracker, getTokenTracker, selectHybridAccount, type AccountWithMetrics } from "./rotation";
import { generateFingerprint, updateFingerprintVersion, type Fingerprint, type FingerprintVersion, MAX_FINGERPRINT_HISTORY } from "./fingerprint";
import type { QuotaGroup, QuotaGroupSummary, QuotaModelSummary } from "./quota";
import { getModelFamily } from "./transform/model-resolver";
import { debugLogToFile } from "./debug";
import { formatAccountLabel, formatWaitTime } from "./logging-utils";
import { formatResetStamp } from "./reset-time";


export type { ModelFamily, HeaderStyle, CooldownReason } from "./storage";
export type { AccountSelectionStrategy } from "./config/schema";


export type RateLimitReason = 
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMIT_EXCEEDED" 
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "UNKNOWN";

export interface RateLimitBackoffResult {
  backoffMs: number;
  reason: RateLimitReason;
}

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000] as const;
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000;
// Increased from 15s to 45s base + jitter to reduce retry pressure on capacity errors
const MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF = 45_000;
const MODEL_CAPACITY_EXHAUSTED_JITTER_MAX = 30_000; // ±15s jitter range
const SERVER_ERROR_BACKOFF = 20_000;
const UNKNOWN_BACKOFF = 60_000;
const MIN_BACKOFF_MS = 2_000;

/**
 * Generate a random jitter value for backoff timing.
 * Helps prevent thundering herd problem when multiple clients retry simultaneously.
 */
function generateJitter(maxJitterMs: number): number {
  return Math.random() * maxJitterMs - (maxJitterMs / 2);
}

export function parseRateLimitReason(
  reason: string | undefined, 
  message: string | undefined, 
  status?: number
): RateLimitReason {
  // 1. Status Code Checks (Rust parity)
  // 529 = Site Overloaded, 503 = Service Unavailable -> Capacity issues
  if (status === 529 || status === 503) return "MODEL_CAPACITY_EXHAUSTED";
  // 500 = Internal Server Error -> Treat as Server Error (soft wait)
  if (status === 500) return "SERVER_ERROR";

  // 2. Explicit Reason String
  if (reason) {
    switch (reason.toUpperCase()) {
      case "QUOTA_EXHAUSTED": return "QUOTA_EXHAUSTED";
      // AI credit (G1) balance exhausted: back off and rotate like other quota exhaustion
      case "INSUFFICIENT_G1_CREDITS_BALANCE": return "QUOTA_EXHAUSTED";
      case "RATE_LIMIT_EXCEEDED": return "RATE_LIMIT_EXCEEDED";
      case "MODEL_CAPACITY_EXHAUSTED": return "MODEL_CAPACITY_EXHAUSTED";
    }
  }
  
  // 3. Message Text Scanning (Rust Regex parity)
  if (message) {
    const lower = message.toLowerCase();

    // G1 credit exhaustion can arrive only inside the message text (e.g. a JSON error body)
    if (lower.includes("insufficient_g1_credits_balance") || lower.includes("g1 credits balance")) {
      return "QUOTA_EXHAUSTED";
    }
    
    // Capacity / Overloaded (Transient) - Check FIRST before "exhausted"
    if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("resource exhausted")) {
      return "MODEL_CAPACITY_EXHAUSTED";
    }

    // RPM / TPM (Short Wait)
    // "per minute", "rate limit", "too many requests"
    // "presque" (French: almost) - retained for i18n parity with Rust reference
    if (lower.includes("per minute") || lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("presque")) {
      return "RATE_LIMIT_EXCEEDED";
    }

    // Quota (Long Wait)
    if (lower.includes("exhausted") || lower.includes("quota")) {
      return "QUOTA_EXHAUSTED";
    }
  }
  
  // Default fallback for 429 without clearer info
  if (status === 429) {
    return "UNKNOWN"; 
  }
  
  return "UNKNOWN";
}

// A 403 that carries one of these markers means the account ran out of quota.
// Retrying the same account or another endpoint cannot help; rotating can.
const FORBIDDEN_QUOTA_MARKERS = [
  "resource_exhausted",
  "resource exhausted",
  "resource has been exhausted",
  "quota_exceeded",
  "quota exceeded",
  "exceeded your current quota",
  "rate limit exceeded",
]

/**
 * Classifies a 403 body. Google reports exhausted quota as
 * `403 RESOURCE_EXHAUSTED` rather than 429, which the 429 handler never sees, so
 * the response used to reach the session as a bare "Forbidden".
 *
 * Returns `undefined` for verification challenges and for genuinely forbidden
 * requests, which need their own handling.
 */
export function parseForbiddenQuotaReason(
  reason: string | undefined,
  message: string | undefined,
  rawBody?: string,
): RateLimitReason | undefined {
  const text = [reason, message, rawBody]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
  if (!text) return undefined;

  // Google asks for account verification with 403 too; that is not a quota.
  if (text.includes("validation_required") || text.includes("accounts.google.com/")) {
    return undefined;
  }

  if (text.includes("insufficient_g1_credits_balance") || text.includes("g1 credits balance")) {
    return "QUOTA_EXHAUSTED";
  }

  if (FORBIDDEN_QUOTA_MARKERS.some((marker) => text.includes(marker))) {
    return "QUOTA_EXHAUSTED";
  }

  return undefined;
}

export function calculateBackoffMs(
  reason: RateLimitReason,
  consecutiveFailures: number,
  retryAfterMs?: number | null
): number {
  // Respect explicit Retry-After header if reasonable
  if (retryAfterMs && retryAfterMs > 0) {
    // Rust uses 2s min buffer, we keep 2s
    return Math.max(retryAfterMs, MIN_BACKOFF_MS);
  }
  
  switch (reason) {
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1);
      return QUOTA_EXHAUSTED_BACKOFFS[index] ?? UNKNOWN_BACKOFF;
    }
    case "RATE_LIMIT_EXCEEDED":
      return RATE_LIMIT_EXCEEDED_BACKOFF; // 30s
    case "MODEL_CAPACITY_EXHAUSTED":
      // Apply jitter to prevent thundering herd on capacity errors
      return MODEL_CAPACITY_EXHAUSTED_BASE_BACKOFF + generateJitter(MODEL_CAPACITY_EXHAUSTED_JITTER_MAX);
    case "SERVER_ERROR":
      return SERVER_ERROR_BACKOFF; // 20s
    case "UNKNOWN":
    default:
      return UNKNOWN_BACKOFF; // 60s
  }
}

export type BaseQuotaKey = "claude" | "gemini-antigravity" | "gemini-cli";
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

export interface ManagedAccount {
  index: number;
  id?: string;
  email?: string;
  addedAt: number;
  lastUsed: number;
  parts: RefreshParts;
  access?: string;
  expires?: number;
  enabled: boolean;
  rateLimitResetTimes: RateLimitStateV3;
  lastSwitchReason?: "rate-limit" | "initial" | "rotation";
  coolingDownUntil?: number;
  cooldownReason?: CooldownReason;
  touchedForQuota: Record<string, number>;
  consecutiveFailures?: number;
  /** Timestamp of last failure for TTL-based reset of consecutiveFailures */
  lastFailureTime?: number;
  /** Per-account device fingerprint for rate limit mitigation */
  fingerprint?: import("./fingerprint").Fingerprint;
  /** History of previous fingerprints for this account */
  fingerprintHistory?: FingerprintVersion[];
  /** Cached quota data from last checkAccountsQuota() call */
  cachedQuota?: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  cachedQuotaUpdatedAt?: number;
  /** Deterministic product-license rejection bench (SUBSCRIPTION_REQUIRED):
   * Google cannot grant the entitlement on retry, so selection skips the
   * account for that family until this timestamp. */
  licenseBlockedUntil?: Partial<Record<ModelFamily, number>>;
  licenseBlockReason?: string;
  verificationRequired?: boolean;
  verificationRequiredAt?: number;
  verificationRequiredReason?: string;
  verificationUrl?: string;
}

function nowMs(): number {
  return Date.now();
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value < 0 ? 0 : Math.floor(value);
}

/** Bounded wait reported for an account that is soft-quota blocked but whose
 * cached group carries no parseable reset time. Keeps the selection guard in
 * wait-and-retry mode instead of failing fast on an underivable wait. */
const SOFT_QUOTA_UNKNOWN_WAIT_MS = 60_000;

function getQuotaKey(family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): QuotaKey {
  if (family === "claude") {
    return "claude";
  }
  const base = headerStyle === "gemini-cli" ? "gemini-cli" : "gemini-antigravity";
  if (model) {
    return `${base}:${model}`;
  }
  return base;
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
  const resetTime = account.rateLimitResetTimes[key];
  return resetTime !== undefined && nowMs() < resetTime;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily, model?: string | null): boolean {
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }
  
  const antigravityIsLimited = isRateLimitedForHeaderStyle(account, family, "antigravity", model);
  const cliIsLimited = isRateLimitedForHeaderStyle(account, family, "gemini-cli", model);
  
  return antigravityIsLimited && cliIsLimited;
}

function isRateLimitedForHeaderStyle(account: ManagedAccount, family: ModelFamily, headerStyle: HeaderStyle, model?: string | null): boolean {
  clearExpiredRateLimits(account);
  
  if (family === "claude") {
    return isRateLimitedForQuotaKey(account, "claude");
  }

  // Check model-specific quota first if provided
  if (model) {
    const modelKey = getQuotaKey(family, headerStyle, model);
    if (isRateLimitedForQuotaKey(account, modelKey)) {
      return true;
    }
  }

  // Then check base family quota
  const baseKey = getQuotaKey(family, headerStyle);
  return isRateLimitedForQuotaKey(account, baseKey);
}

function clearExpiredRateLimits(account: ManagedAccount): void {
  const now = nowMs();
  const keys = Object.keys(account.rateLimitResetTimes) as QuotaKey[];
  for (const key of keys) {
    const resetTime = account.rateLimitResetTimes[key];
    if (resetTime !== undefined && now >= resetTime) {
      delete account.rateLimitResetTimes[key];
    }
  }
}

/** True while a product-license bench for the family is active. Expired
 * benches are dropped lazily so persistence stops rewriting them. */
export function isLicenseBlocked(account: ManagedAccount, family: ModelFamily): boolean {
  const until = account.licenseBlockedUntil?.[family];
  if (until === undefined) return false;
  if (nowMs() < until) return true;
  delete account.licenseBlockedUntil?.[family];
  if (account.licenseBlockedUntil && Object.keys(account.licenseBlockedUntil).length === 0) {
    account.licenseBlockedUntil = undefined;
    account.licenseBlockReason = undefined;
  }
  return false;
}

/** True when a quota group reports quota left, either on the group aggregate
 * or on at least one of its per-model entries. */
function groupHasAvailableQuota(groupData: QuotaGroupSummary | undefined): boolean {
  if (!groupData) return false;
  if ((groupData.remainingFraction ?? 0) > 0) return true;
  return Object.values(groupData.models ?? {}).some((entry) => (entry.remainingFraction ?? 0) > 0);
}

/** True when the requested model still has quota in its group. A model that
 * is missing from the per-model map falls back to the group aggregate, which
 * is the minimum across models, so an unreported model is not assumed free. */
function modelHasAvailableQuota(groupData: QuotaGroupSummary | undefined, model: string): boolean {
  if (!groupData) return false;
  const entry = perModelQuotaEntry(groupData, model);
  if (entry?.remainingFraction != null) return entry.remainingFraction > 0;
  return (groupData.remainingFraction ?? 0) > 0;
}

/** Family a persisted rate-limit key belongs to, or null when unrecognized. */
function familyForQuotaKey(key: QuotaKey): ModelFamily | null {
  if (key === "claude") return "claude";
  if (key.startsWith("gemini-antigravity") || key.startsWith("gemini-cli")) return "gemini";
  return null;
}

/** Model part of a per-model rate-limit key, or null for a base family key. */
function modelForQuotaKey(key: QuotaKey): string | null {
  const separator = key.indexOf(":");
  return separator === -1 ? null : key.slice(separator + 1);
}

/**
 * Resolve the quota group for soft quota checks.
 * 
 * When a model string is available, we can precisely determine the quota group.
 * When model is null/undefined, we fall back based on family:
 * - Claude → "claude" quota group
 * - Gemini → "gemini-pro" (conservative fallback; may misclassify flash models)
 * 
 * @param family - The model family ("claude" | "gemini")
 * @param model - Optional model string for precise resolution
 * @returns The QuotaGroup to use for soft quota checks
 */
export function resolveQuotaGroup(family: ModelFamily, model?: string | null): QuotaGroup {
  if (model) {
    return getModelFamily(model);
  }
  return family === "claude" ? "claude" : "gemini-pro";
}

/** Candidate keys for a requested model in the per-model quota map: the raw
 * name plus variants with the antigravity quota prefix, thinking-tier suffix,
 * and -preview suffix stripped - the same transforms resolveModelForHeaderStyle
 * applies before the request is sent. */
function quotaModelCandidates(model?: string | null): string[] {
  if (!model) return [];
  const lower = model.toLowerCase();
  const prefixStripped = lower.replace(/^antigravity-/i, "");
  const tierMatch = prefixStripped.match(/-(minimal|low|medium|high|tiered)$/i);
  const ownTier = tierMatch?.[1] ? `-${tierMatch[1].toLowerCase()}` : undefined;
  const base = prefixStripped
    .replace(/-(minimal|low|medium|high|tiered)$/i, "")
    .replace(/-preview$/i, "");
  // The cache stores the tier-suffixed names the backend reports (e.g.
  // gemini-3.8-flash-high), so a bare request must also try the tier
  // variants. The request's own tier, if any, wins before the defaults,
  // and -high leads the defaults because bare gemini-3 requests resolve
  // to the high tier in practice.
  const candidates = [model, lower, prefixStripped, base];
  for (const tier of [...(ownTier ? [ownTier] : []), "-high", "-medium", "-low", "-minimal", "-tiered"]) {
    candidates.push(`${base}${tier}`);
  }
  return [...new Set(candidates)];
}

/** The requested model's own quota entry, falling back through name variants. */
function perModelQuotaEntry(
  groupData: QuotaGroupSummary | undefined,
  model?: string | null
): QuotaModelSummary | undefined {
  if (!groupData?.models) return undefined;
  for (const key of quotaModelCandidates(model)) {
    const entry = groupData.models[key];
    if (entry) return entry;
  }
  return undefined;
}

function isOverSoftQuotaThreshold(
  account: ManagedAccount,
  family: ModelFamily,
  thresholdPercent: number,
  cacheTtlMs: number,
  model?: string | null
): boolean {
  if (thresholdPercent >= 100) return false;
  if (!account.cachedQuota) return false;
  
  if (account.cachedQuotaUpdatedAt == null) return false;
  const age = nowMs() - account.cachedQuotaUpdatedAt;
  if (age > cacheTtlMs) return false;
  
  const quotaGroup = resolveQuotaGroup(family, model);
  
  const groupData = account.cachedQuota[quotaGroup];
  if (groupData?.remainingFraction == null) return false;
  
  // Prefer the requested model's own quota entry over the group minimum, so a
  // depleted sibling model no longer blocks a model that still has quota.
  const modelEntry = perModelQuotaEntry(groupData, model);
  const remainingFraction = Math.max(0, Math.min(1, modelEntry?.remainingFraction ?? groupData.remainingFraction));
  const usedPercent = (1 - remainingFraction) * 100;
  const isOverThreshold = usedPercent >= thresholdPercent;
  
  if (isOverThreshold) {
    const accountLabel = formatAccountLabel(account.email, account.index);
    const resetTime = modelEntry?.resetTime ?? groupData.resetTime;
    const resetSuffix = resetTime ? ` (resets: ${resetTime})` : "";
    const message = `[SoftQuota] Skipping ${accountLabel}: ${quotaGroup} usage ${usedPercent.toFixed(1)}% >= threshold ${thresholdPercent}%${resetSuffix}`;
    debugLogToFile(message);
  }
  
  return isOverThreshold;
}

export function computeSoftQuotaCacheTtlMs(
  ttlConfig: "auto" | number,
  refreshIntervalMinutes: number
): number {
  if (ttlConfig === "auto") {
    return Math.max(2 * refreshIntervalMinutes, 10) * 60 * 1000;
  }
  return ttlConfig * 60 * 1000;
}

/**
 * In-memory multi-account manager with sticky account selection.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 *
 * Source of truth for the pool is `antigravity-accounts.json`.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private cursor = 0;
  private currentAccountIndexByFamily: Record<ModelFamily, number> = {
    claude: -1,
    gemini: -1,
  };
  private sessionOffsetApplied: Record<ModelFamily, boolean> = {
    claude: false,
    gemini: false,
  };
  private lastToastAccountIndex = -1;
  private lastToastTime = 0;

  private savePending = false;
  private retired = false;
  private activeSaves = new Set<Promise<void>>();
  private saveTail: Promise<void> = Promise.resolve();
  private managedStorage = false;
  /** Rate-limit markers removed by quota reconciliation, with the reset value
   * they carried. Managed storage merges limits with Math.max, which would
   * resurrect a deletion, so a clear only reaches disk while the persisted
   * value still matches what was removed. */
  private clearedRateLimits = new Map<number, Map<QuotaKey, number>>();
  private persistedAccounts = new Map<number, { refreshToken: string; projectId?: string; managedProjectId?: string; enabled: boolean; fingerprintID?: string }>();
  private credentialSources = new Map<number, Map<string, RefreshParts>>();
  private persistedSelections: Partial<Record<ModelFamily, string>> = {};
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private savePromiseResolvers: Array<() => void> = [];

  static async loadFromDisk(authFallback?: OAuthAuthDetails, managedStorage = false): Promise<AccountManager> {
    const stored = await loadAccounts();
    const manager = new AccountManager(authFallback, stored, managedStorage);
    if (managedStorage) manager.useManagedStorage();
    return manager;
  }

  constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV4 | null, managedStorage = false) {
    const authParts = authFallback ? parseRefreshParts(authFallback.refresh) : null;

    if (stored && stored.accounts.length === 0) {
      this.accounts = [];
      this.cursor = 0;
      return;
    }

    if (stored && stored.accounts.length > 0) {
      const baseNow = nowMs();
      this.accounts = stored.accounts
        .map((acc, index): ManagedAccount | null => {
          if (!acc.refreshToken || typeof acc.refreshToken !== "string") {
            return null;
          }
          const matchesFallback = !!(
            authFallback &&
            authParts &&
            authParts.refreshToken &&
            acc.refreshToken === authParts.refreshToken
          );

          return {
            index,
            id: acc.id,
            email: acc.email,
            addedAt: clampNonNegativeInt(acc.addedAt, baseNow),
            lastUsed: clampNonNegativeInt(acc.lastUsed, 0),
            parts: {
              refreshToken: acc.refreshToken,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
            },
            access: matchesFallback ? authFallback?.access : undefined,
            expires: matchesFallback ? authFallback?.expires : undefined,
            enabled: acc.enabled !== false,
            rateLimitResetTimes: acc.rateLimitResetTimes ?? {},
            lastSwitchReason: acc.lastSwitchReason,
            coolingDownUntil: acc.coolingDownUntil,
            cooldownReason: acc.cooldownReason,
            touchedForQuota: {},
            fingerprint: acc.fingerprint ?? generateFingerprint(),
            fingerprintHistory: acc.fingerprintHistory ?? [],
            cachedQuota: acc.cachedQuota as Partial<Record<QuotaGroup, QuotaGroupSummary>> | undefined,
            cachedQuotaUpdatedAt: acc.cachedQuotaUpdatedAt,
            licenseBlockedUntil: acc.licenseBlockedUntil,
            licenseBlockReason: acc.licenseBlockReason,
            verificationRequired: acc.verificationRequired,
            verificationRequiredAt: acc.verificationRequiredAt,
            verificationRequiredReason: acc.verificationRequiredReason,
            verificationUrl: acc.verificationUrl,
          };
        })
        .filter((a): a is ManagedAccount => a !== null);

      // Update fingerprint versions to match the current runtime version.
      // Saved fingerprints may carry an older version string; this ensures
      // they always reflect the latest fetched (or fallback) version.
      let fingerprintVersionChanged = false;
      for (const acc of this.accounts) {
        if (acc.fingerprint && updateFingerprintVersion(acc.fingerprint)) {
          fingerprintVersionChanged = true;
        }
      }

      // Rate-limit markers persisted by an earlier session can outlive the
      // quota window they recorded. Reconciling them against the cached quota
      // at load time keeps a stale marker from blocking the pool for days,
      // because quota refreshes are only triggered by successful requests.
      let rateLimitsReconciled = false;
      for (const acc of this.accounts) {
        if (acc.cachedQuota && this.reconcileRateLimitsWithQuota(acc, acc.cachedQuota)) {
          rateLimitsReconciled = true;
        }
      }

      this.cursor = clampNonNegativeInt(stored.activeIndex, 0);
      if (this.accounts.length > 0) {
        this.cursor = this.cursor % this.accounts.length;
        const defaultIndex = this.cursor;
        this.currentAccountIndexByFamily.claude = clampNonNegativeInt(
          stored.activeIndexByFamily?.claude,
          defaultIndex
        ) % this.accounts.length;
        this.currentAccountIndexByFamily.gemini = clampNonNegativeInt(
          stored.activeIndexByFamily?.gemini,
          defaultIndex
        ) % this.accounts.length;
      }

      // Persist updated fingerprint versions and reconciled rate limits to disk.
      // Managed storage merges rather than replaces, so a reconciled deletion
      // has to be flushed through its patch path as well.
      if (rateLimitsReconciled || (fingerprintVersionChanged && !managedStorage)) {
        this.requestSaveToDisk();
      }

      return;
    }

    // If we have stored accounts, check if we need to add the current auth
    if (authFallback && this.accounts.length > 0) {
      const authParts = parseRefreshParts(authFallback.refresh);
      const hasMatching = this.accounts.some(acc => acc.parts.refreshToken === authParts.refreshToken);
      if (!hasMatching && authParts.refreshToken) {
        const now = nowMs();
        const newAccount: ManagedAccount = {
          index: this.accounts.length,
          email: undefined,
          addedAt: now,
          lastUsed: 0,
          parts: authParts,
          access: authFallback.access,
          expires: authFallback.expires,
          enabled: true,
          rateLimitResetTimes: {},
          touchedForQuota: {},
        };
        this.accounts.push(newAccount);
        // Update indices to include the new account
        this.currentAccountIndexByFamily.claude = Math.min(this.currentAccountIndexByFamily.claude, this.accounts.length - 1);
        this.currentAccountIndexByFamily.gemini = Math.min(this.currentAccountIndexByFamily.gemini, this.accounts.length - 1);
      }
    }

    if (authFallback) {
      const parts = parseRefreshParts(authFallback.refresh);
      if (parts.refreshToken) {
        const now = nowMs();
        this.accounts = [
          {
            index: 0,
            email: undefined,
            addedAt: now,
            lastUsed: 0,
            parts,
            access: authFallback.access,
            expires: authFallback.expires,
            enabled: true,
            rateLimitResetTimes: {},
            touchedForQuota: {},
          },
        ];
        this.cursor = 0;
        this.currentAccountIndexByFamily.claude = 0;
        this.currentAccountIndexByFamily.gemini = 0;
      }
    }
  }

  getAccountCount(): number {
    return this.getEnabledAccounts().length;
  }

  getTotalAccountCount(): number {
    return this.accounts.length;
  }

  getEnabledAccounts(): ManagedAccount[] {
    return this.accounts.filter((account) => account.enabled !== false);
  }

  getAccountsSnapshot(): ManagedAccount[] {
    return this.accounts.map((a) => ({ ...a, parts: { ...a.parts }, rateLimitResetTimes: { ...a.rateLimitResetTimes } }));
  }

  getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
    const currentIndex = this.currentAccountIndexByFamily[family];
    if (currentIndex >= 0 && currentIndex < this.accounts.length) {
      const account = this.accounts[currentIndex] ?? null;
      // Only return account if it's enabled - disabled accounts should not be selected
      if (account && account.enabled !== false) {
        return account;
      }
    }
    return null;
  }

  markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation", family: ModelFamily): void {
    account.lastSwitchReason = reason;
    this.currentAccountIndexByFamily[family] = account.index;
  }

  /**
   * Check if we should show an account switch toast.
   * Debounces repeated toasts for the same account.
   */
  shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
    const now = nowMs();
    if (accountIndex !== this.lastToastAccountIndex) {
      return true;
    }
    return now - this.lastToastTime >= debounceMs;
  }

  markToastShown(accountIndex: number): void {
    this.lastToastAccountIndex = accountIndex;
    this.lastToastTime = nowMs();
  }

  getCurrentOrNextForFamily(
    family: ModelFamily, 
    model?: string | null,
    strategy: AccountSelectionStrategy = 'sticky',
    headerStyle: HeaderStyle = 'antigravity',
    pidOffsetEnabled: boolean = false,
    softQuotaThresholdPercent: number = 100,
    softQuotaCacheTtlMs: number = 10 * 60 * 1000,
    eligible: (account: ManagedAccount) => boolean = () => true,
  ): ManagedAccount | null {
    const quotaKey = getQuotaKey(family, headerStyle, model);

    if (strategy === 'round-robin') {
      const next = this.getNextForFamily(family, model, headerStyle, softQuotaThresholdPercent, softQuotaCacheTtlMs, eligible);
      if (next) {
        this.markTouchedForQuota(next, quotaKey);
        this.currentAccountIndexByFamily[family] = next.index;
      }
      return next;
    }

    if (strategy === 'hybrid') {
      const healthTracker = getHealthTracker();
      const tokenTracker = getTokenTracker();
      
      const accountsWithMetrics: AccountWithMetrics[] = this.accounts
        .filter(acc => acc.enabled !== false && eligible(acc))
        .map(acc => {
          clearExpiredRateLimits(acc);
          return {
            index: acc.index,
            lastUsed: acc.lastUsed,
            healthScore: healthTracker.getScore(acc.index),
            // Per-pool check, mirroring the per-round skip check and the
            // getNextForFamily filter. The old both-pools check selected
            // accounts it would immediately skip when only one quota pool
            // carried a mark, burning rounds without sending anything.
            isRateLimited: isRateLimitedForHeaderStyle(acc, family, headerStyle, model) ||
                          isOverSoftQuotaThreshold(acc, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model) ||
                          isLicenseBlocked(acc, family),
            isCoolingDown: this.isAccountCoolingDown(acc),
          };
        });

      // Get current account index for stickiness
      const currentIndex = this.currentAccountIndexByFamily[family] ?? null;
      
      const selectedIndex = selectHybridAccount(accountsWithMetrics, tokenTracker, currentIndex, healthTracker.getMinUsable());
      if (selectedIndex !== null) {
        const selected = this.accounts[selectedIndex];
        if (selected) {
          selected.lastUsed = nowMs();
          this.markTouchedForQuota(selected, quotaKey);
          this.currentAccountIndexByFamily[family] = selected.index;
          return selected;
        }
      }
      // Sticky may still rescue the current account below, but the hybrid
      // exclusion reasons explain why the health/token-aware path gave up.
      const hybridExclusions = this.describeSelectionExclusions(family, model, headerStyle, softQuotaThresholdPercent, softQuotaCacheTtlMs, eligible);
      debugLogToFile(`[SelectionGate] hybrid no candidate family=${family} model=${model ?? "-"} style=${headerStyle} excluded: ${hybridExclusions || "none"}`);
    }

    // Fallback: sticky selection (used when hybrid finds no candidates)
    // PID-based offset for multi-session distribution (opt-in)
    // Different sessions (PIDs) will prefer different starting accounts
    if (pidOffsetEnabled && !this.sessionOffsetApplied[family] && this.accounts.length > 1) {
      const pidOffset = process.pid % this.accounts.length;
      const baseIndex = this.currentAccountIndexByFamily[family] ?? 0;
      const newIndex = (baseIndex + pidOffset) % this.accounts.length;
      
      debugLogToFile(`[Account] Applying PID offset: pid=${process.pid} offset=${pidOffset} family=${family} index=${baseIndex}->${newIndex}`);
      
      this.currentAccountIndexByFamily[family] = newIndex;
      this.sessionOffsetApplied[family] = true;
    }

    const current = this.getCurrentAccountForFamily(family);
    if (current && eligible(current)) {
      clearExpiredRateLimits(current);
      const isLimitedForRequestedStyle = isRateLimitedForHeaderStyle(current, family, headerStyle, model);
      const isOverThreshold = isOverSoftQuotaThreshold(current, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model);
      if (!isLimitedForRequestedStyle && !isOverThreshold && !this.isAccountCoolingDown(current) && !isLicenseBlocked(current, family)) {
        this.markTouchedForQuota(current, quotaKey);
        return current;
      }
    }

    const next = this.getNextForFamily(family, model, headerStyle, softQuotaThresholdPercent, softQuotaCacheTtlMs, eligible);
    if (next) {
      this.markTouchedForQuota(next, quotaKey);
      this.currentAccountIndexByFamily[family] = next.index;
    }
    return next;
  }

  /** One compact reason per enabled+eligible account that the selection gates
   * excluded, for the debug file. Returns "" when nothing was excluded. */
  private describeSelectionExclusions(
    family: ModelFamily,
    model: string | null | undefined,
    headerStyle: HeaderStyle,
    softQuotaThresholdPercent: number,
    softQuotaCacheTtlMs: number,
    eligible: (account: ManagedAccount) => boolean,
  ): string {
    const healthTracker = getHealthTracker();
    const minUsable = healthTracker.getMinUsable();
    const parts: string[] = [];
    for (const a of this.accounts) {
      if (a.enabled === false || !eligible(a)) continue;
      clearExpiredRateLimits(a);
      const reasons: string[] = [];
      if (isRateLimitedForHeaderStyle(a, family, headerStyle, model)) reasons.push("rate-limited");
      if (this.isAccountCoolingDown(a)) reasons.push("cooling-down");
      if (isLicenseBlocked(a, family)) reasons.push("license-blocked");
      if (isOverSoftQuotaThreshold(a, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model)) reasons.push("soft-quota");
      const healthScore = healthTracker.getScore(a.index);
      if (healthScore < minUsable) reasons.push(`health=${healthScore}<${minUsable}`);
      if (reasons.length > 0) parts.push(`${a.index}=${reasons.join("+")}`);
    }
    return parts.join("; ");
  }

  getNextForFamily(family: ModelFamily, model?: string | null, headerStyle: HeaderStyle = "antigravity", softQuotaThresholdPercent: number = 100, softQuotaCacheTtlMs: number = 10 * 60 * 1000, eligible: (account: ManagedAccount) => boolean = () => true): ManagedAccount | null {
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      return a.enabled !== false && eligible(a) &&
             !isRateLimitedForHeaderStyle(a, family, headerStyle, model) && 
             !isOverSoftQuotaThreshold(a, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model) &&
             !this.isAccountCoolingDown(a) &&
             !isLicenseBlocked(a, family);
    });

    if (available.length === 0) {
      // Why nothing qualified: this is the exact question a fatal
      // "no candidate" incident needs answered after the fact.
      const exclusions = this.describeSelectionExclusions(family, model, headerStyle, softQuotaThresholdPercent, softQuotaCacheTtlMs, eligible);
      debugLogToFile(`[SelectionGate] no candidate family=${family} model=${model ?? "-"} style=${headerStyle} excluded: ${exclusions || "none"}`);
      return null;
    }

    const account = available[this.cursor % available.length];
    if (!account) {
      return null;
    }

    this.cursor++;
    // Note: lastUsed is now updated after successful request via markAccountUsed()
    return account;
  }

  markRateLimited(
    account: ManagedAccount,
    retryAfterMs: number,
    family: ModelFamily,
    headerStyle: HeaderStyle = "antigravity",
    model?: string | null
  ): void {
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = nowMs() + retryAfterMs;
  }

  /**
   * Bench the account for the family after a deterministic product-license
   * rejection (403 SUBSCRIPTION_REQUIRED). Unlike a rate limit, Google cannot
   * grant the entitlement on retry, so selection skips the account until the
   * bench expires or the user re-enables it. Longer blocks win so concurrent
   * families cannot shorten an existing bench.
   */
  markLicenseBlocked(account: ManagedAccount, family: ModelFamily, durationMs: number, reason = "SUBSCRIPTION_REQUIRED"): number {
    const until = nowMs() + Math.max(0, durationMs);
    if (until <= (account.licenseBlockedUntil?.[family] ?? 0)) {
      return Math.max(0, (account.licenseBlockedUntil?.[family] ?? 0) - nowMs());
    }
    account.licenseBlockedUntil ??= {};
    account.licenseBlockedUntil[family] = until;
    account.licenseBlockReason = reason;
    this.requestSaveToDisk();
    return Math.max(0, until - nowMs());
  }

  /**
   * Mark an account as used after a successful API request.
   * This updates the lastUsed timestamp for freshness calculations.
   * Should be called AFTER request completion, not during account selection.
   */
  markAccountUsed(accountIndex: number): void {
    const account = this.accounts.find(a => a.index === accountIndex);
    if (account) {
      account.lastUsed = nowMs();
    }
  }

  markRateLimitedWithReason(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model: string | null | undefined,
    reason: RateLimitReason,
    retryAfterMs?: number | null,
    failureTtlMs: number = 3600_000, // Default 1 hour TTL
  ): number {
    const now = nowMs();
    
    // TTL-based reset: if last failure was more than failureTtlMs ago, reset count
    if (account.lastFailureTime !== undefined && (now - account.lastFailureTime) > failureTtlMs) {
      account.consecutiveFailures = 0;
    }
    
    const failures = (account.consecutiveFailures ?? 0) + 1;
    account.consecutiveFailures = failures;
    account.lastFailureTime = now;
    
    const backoffMs = calculateBackoffMs(reason, failures - 1, retryAfterMs);
    const key = getQuotaKey(family, headerStyle, model);
    account.rateLimitResetTimes[key] = now + backoffMs;
    
    return backoffMs;
  }

  markRequestSuccess(account: ManagedAccount): void {
    if (account.consecutiveFailures) {
      account.consecutiveFailures = 0;
    }
  }

  clearAllRateLimitsForFamily(family: ModelFamily, model?: string | null): void {
    for (const account of this.accounts) {
      if (family === "claude") {
        delete account.rateLimitResetTimes.claude;
      } else {
        const antigravityKey = getQuotaKey(family, "antigravity", model);
        const cliKey = getQuotaKey(family, "gemini-cli", model);
        delete account.rateLimitResetTimes[antigravityKey];
        delete account.rateLimitResetTimes[cliKey];
      }
      account.consecutiveFailures = 0;
    }
  }

  shouldTryOptimisticReset(family: ModelFamily, model?: string | null): boolean {
    const minWaitMs = this.getMinWaitTimeForFamily(family, model);
    return minWaitMs > 0 && minWaitMs <= 2_000;
  }

  markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void {
    account.coolingDownUntil = nowMs() + cooldownMs;
    account.cooldownReason = reason;
  }

  isAccountCoolingDown(account: ManagedAccount): boolean {
    if (account.coolingDownUntil === undefined) {
      return false;
    }
    if (nowMs() >= account.coolingDownUntil) {
      this.clearAccountCooldown(account);
      return false;
    }
    return true;
  }

  clearAccountCooldown(account: ManagedAccount): void {
    delete account.coolingDownUntil;
    delete account.cooldownReason;
  }

  getAccountCooldownReason(account: ManagedAccount): CooldownReason | undefined {
    return this.isAccountCoolingDown(account) ? account.cooldownReason : undefined;
  }

  markTouchedForQuota(account: ManagedAccount, quotaKey: string): void {
    account.touchedForQuota[quotaKey] = nowMs();
  }

  isFreshForQuota(account: ManagedAccount, quotaKey: string): boolean {
    const touchedAt = account.touchedForQuota[quotaKey];
    if (!touchedAt) return true;
    
    const resetTime = account.rateLimitResetTimes[quotaKey as QuotaKey];
    if (resetTime && touchedAt < resetTime) return true;
    
    return false;
  }

  getFreshAccountsForQuota(quotaKey: string, family: ModelFamily, model?: string | null): ManagedAccount[] {
    return this.accounts.filter(acc => {
      clearExpiredRateLimits(acc);
      return acc.enabled !== false &&
             this.isFreshForQuota(acc, quotaKey) && 
             !isRateLimitedForFamily(acc, family, model) && 
             !this.isAccountCoolingDown(acc);
    });
  }

  isRateLimitedForHeaderStyle(
    account: ManagedAccount,
    family: ModelFamily,
    headerStyle: HeaderStyle,
    model?: string | null
  ): boolean {
    return isRateLimitedForHeaderStyle(account, family, headerStyle, model);
  }

  getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily, model?: string | null): HeaderStyle | null {
    clearExpiredRateLimits(account);
    if (family === "claude") {
      return isRateLimitedForHeaderStyle(account, family, "antigravity") ? null : "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "antigravity", model)) {
      return "antigravity";
    }
    if (!isRateLimitedForHeaderStyle(account, family, "gemini-cli", model)) {
      return "gemini-cli";
    }
    return null;
  }

  /**
   * Check if any OTHER account has antigravity quota available for the given family/model.
   * 
   * Used to determine whether to switch accounts vs fall back to gemini-cli:
   * - If true: Switch to another account (preserve antigravity priority)
   * - If false: All accounts exhausted antigravity, safe to fall back to gemini-cli
   *
   * Accounts held back by the soft quota guard count as unavailable here, because
   * selection skips them: reporting them as available makes every round switch
   * accounts without ever falling back or sending a request.
   *
   * @param currentAccountIndex - Index of the current account (will be excluded from check)
   * @param family - Model family ("gemini" or "claude")
   * @param model - Optional model name for model-specific rate limits
   * @param eligible - Additional account filter applied by the caller
   * @param softQuotaThresholdPercent - Soft quota threshold used by account selection
   * @param softQuotaCacheTtlMs - Maximum age of a cached quota reading
   * @returns true if any other enabled, non-cooling-down account has antigravity available
   */
  hasOtherAccountWithAntigravityAvailable(
    currentAccountIndex: number,
    family: ModelFamily,
    model?: string | null,
    eligible: (account: ManagedAccount) => boolean = () => true,
    softQuotaThresholdPercent: number = 100,
    softQuotaCacheTtlMs: number = 0,
  ): boolean {
    // Claude has no gemini-cli fallback - always return false
    // (This method is only relevant for Gemini's dual quota pools)
    if (family === "claude") {
      return false;
    }

    return this.accounts.some(acc => {
      // Skip current account
      if (acc.index === currentAccountIndex) {
        return false;
      }
      // Skip disabled accounts
      if (acc.enabled === false || !eligible(acc)) {
        return false;
      }
      // Skip cooling down accounts
      if (this.isAccountCoolingDown(acc)) {
        return false;
      }
      // Accounts above the soft quota threshold are skipped by selection, so
      // they cannot justify switching instead of falling back to gemini-cli.
      if (isOverSoftQuotaThreshold(acc, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model)) {
        return false;
      }
      // Clear expired rate limits before checking
      clearExpiredRateLimits(acc);
      // A license-benched account is skipped by selection, so it cannot
      // justify switching instead of falling back to gemini-cli either.
      if (isLicenseBlocked(acc, family)) {
        return false;
      }
      // Check if antigravity is available for this account
      return !isRateLimitedForHeaderStyle(acc, family, "antigravity", model);
    });
  }

  setAccountEnabled(accountIndex: number, enabled: boolean): boolean {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    account.enabled = enabled;

    if (!enabled) {
      for (const family of Object.keys(this.currentAccountIndexByFamily) as ModelFamily[]) {
        if (this.currentAccountIndexByFamily[family] === accountIndex) {
          const next = this.accounts.find((a, i) => i !== accountIndex && a.enabled !== false);
          this.currentAccountIndexByFamily[family] = next?.index ?? -1;
        }
      }
    } else {
      // Re-enabling is an explicit retry decision: drop any product-license
      // bench so the account is immediately selectable again.
      if (account.licenseBlockedUntil) {
        delete account.licenseBlockedUntil.claude;
        delete account.licenseBlockedUntil.gemini;
      }
      if (account.licenseBlockedUntil && Object.keys(account.licenseBlockedUntil).length === 0) {
        account.licenseBlockedUntil = undefined;
        account.licenseBlockReason = undefined;
      }
    }

    this.requestSaveToDisk();
    return true;
  }

  markAccountVerificationRequired(accountIndex: number, reason?: string, verifyUrl?: string): boolean {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }

    account.verificationRequired = true;
    account.verificationRequiredAt = nowMs();
    account.verificationRequiredReason = reason?.trim() || undefined;

    const normalizedVerifyUrl = verifyUrl?.trim();
    if (normalizedVerifyUrl) {
      account.verificationUrl = normalizedVerifyUrl;
    }

    if (account.enabled !== false) {
      this.setAccountEnabled(accountIndex, false);
    } else {
      this.requestSaveToDisk();
    }

    return true;
  }

  clearAccountVerificationRequired(accountIndex: number, enableAccount = false): boolean {
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }

    const wasVerificationRequired = account.verificationRequired === true;
    const hadMetadata = (
      account.verificationRequiredAt !== undefined ||
      account.verificationRequiredReason !== undefined ||
      account.verificationUrl !== undefined
    );

    account.verificationRequired = false;
    account.verificationRequiredAt = undefined;
    account.verificationRequiredReason = undefined;
    account.verificationUrl = undefined;

    if (enableAccount && wasVerificationRequired && account.enabled === false) {
      this.setAccountEnabled(accountIndex, true);
    } else if (wasVerificationRequired || hadMetadata) {
      this.requestSaveToDisk();
    }

    return true;
  }

  removeAccountByIndex(accountIndex: number): boolean {
    if (accountIndex < 0 || accountIndex >= this.accounts.length) {
      return false;
    }
    const account = this.accounts[accountIndex];
    if (!account) {
      return false;
    }
    return this.removeAccount(account);
  }

  removeAccount(account: ManagedAccount): boolean {
    const idx = this.accounts.indexOf(account);
    if (idx < 0) {
      return false;
    }

    this.accounts.splice(idx, 1);
    this.accounts.forEach((acc, index) => {
      acc.index = index;
    });

    if (this.accounts.length === 0) {
      this.cursor = 0;
      this.currentAccountIndexByFamily.claude = -1;
      this.currentAccountIndexByFamily.gemini = -1;
      return true;
    }

    if (this.cursor > idx) {
      this.cursor -= 1;
    }
    this.cursor = this.cursor % this.accounts.length;

    for (const family of ["claude", "gemini"] as ModelFamily[]) {
      if (this.currentAccountIndexByFamily[family] > idx) {
        this.currentAccountIndexByFamily[family] -= 1;
      }
      if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
        this.currentAccountIndexByFamily[family] = -1;
      }
    }

    return true;
  }

  updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails, previousToken = account.parts.refreshToken): void {
    if (account.parts.refreshToken !== previousToken) return;
    if (this.managedStorage) {
      const sources = this.credentialSources.get(account.index) ?? new Map<string, RefreshParts>();
      sources.set(previousToken, { ...account.parts });
      this.credentialSources.set(account.index, sources);
    }
    const parts = parseRefreshParts(auth.refresh);
    // Preserve existing projectId/managedProjectId if not in the new parts
    account.parts = {
      ...parts,
      projectId: parts.projectId ?? account.parts.projectId,
      managedProjectId: parts.managedProjectId ?? account.parts.managedProjectId,
    };
    account.access = auth.access;
    account.expires = auth.expires;
  }

  toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
    return {
      type: "oauth",
      refresh: formatRefreshParts(account.parts),
      access: account.access,
      expires: account.expires,
    };
  }

  getMinWaitTimeForFamily(
    family: ModelFamily,
    model?: string | null,
    headerStyle?: HeaderStyle,
    strict?: boolean,
    eligible: (account: ManagedAccount) => boolean = () => true,
    softQuotaThresholdPercent: number = 100,
    softQuotaCacheTtlMs: number = 10 * 60 * 1000,
  ): number {
    // Mirror the full skip predicate used by account selection: an account is
    // only available when it is not rate-limited, not cooling down, not over
    // the soft quota threshold, and healthy enough for hybrid selection. The
    // previous version only looked at rate limits, so a pool blocked by
    // cooldowns or the soft quota guard was reported as "available in 0 ms"
    // and callers treated that as fatal.
    const healthTracker = getHealthTracker();
    const minUsable = healthTracker.getMinUsable();
    const available = this.accounts.filter((a) => {
      clearExpiredRateLimits(a);
      if (a.enabled === false || !eligible(a)) return false;
      const rateLimited = strict && headerStyle
        ? isRateLimitedForHeaderStyle(a, family, headerStyle, model)
        : isRateLimitedForFamily(a, family, model);
      if (rateLimited) return false;
      if (this.isAccountCoolingDown(a)) return false;
      if (isLicenseBlocked(a, family)) return false;
      if (isOverSoftQuotaThreshold(a, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model)) return false;
      if (healthTracker.getScore(a.index) < minUsable) return false;
      return true;
    });
    if (available.length > 0) {
      return 0;
    }

    // No account is servable right now: estimate when the FIRST one frees up.
    // An account sits behind ALL of its active blockers at once, so its wait is
    // the longest pending blocker; the pool waits for the shortest account.
    const msUntil = (resetTime?: number): number =>
      resetTime === undefined ? 0 : Math.max(0, resetTime - nowMs());
    // Blocked while EITHER the model key or the base key is pending, mirroring
    // isRateLimitedForHeaderStyle.
    const poolBlockedForMs = (a: ManagedAccount, style: HeaderStyle): number =>
      Math.max(
        msUntil(a.rateLimitResetTimes[getQuotaKey(family, style, model)]),
        msUntil(a.rateLimitResetTimes[getQuotaKey(family, style)]),
      );

    const now = nowMs();
    const waitTimes: number[] = [];
    for (const a of this.accounts) {
      if (a.enabled === false || !eligible(a)) continue;
      const blockers: number[] = [];
      if (family === "claude") {
        blockers.push(msUntil(a.rateLimitResetTimes.claude));
      } else if (strict && headerStyle) {
        blockers.push(poolBlockedForMs(a, headerStyle));
      } else {
        // For Gemini, account becomes available when EITHER pool expires for this model/family
        blockers.push(Math.min(poolBlockedForMs(a, "antigravity"), poolBlockedForMs(a, "gemini-cli")));
      }
      if (a.coolingDownUntil !== undefined && a.coolingDownUntil > now) {
        blockers.push(a.coolingDownUntil - now);
      }
      const licenseBlockedUntil = a.licenseBlockedUntil?.[family];
      if (licenseBlockedUntil !== undefined && licenseBlockedUntil > now) {
        blockers.push(licenseBlockedUntil - now);
      }
      if (
        softQuotaThresholdPercent < 100 &&
        isOverSoftQuotaThreshold(a, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model)
      ) {
        const groupData = a.cachedQuota?.[resolveQuotaGroup(family, model)];
        const resetTime = perModelQuotaEntry(groupData, model)?.resetTime ?? groupData?.resetTime;
        const resetTimestamp = resetTime ? Date.parse(resetTime) : NaN;
        if (Number.isFinite(resetTimestamp) && resetTimestamp > now) {
          blockers.push(resetTimestamp - now);
        } else {
          // Over threshold with no usable reset time: no derivable wait, but the
          // account is still blocked. Report a bounded wait so callers wait and
          // retry instead of declaring the whole pool unusable.
          blockers.push(SOFT_QUOTA_UNKNOWN_WAIT_MS);
        }
      }
      const healthScore = healthTracker.getScore(a.index);
      if (healthScore < minUsable) {
        // Health only recovers passively, at the configured points-per-hour
        // while the account rests, so the wait until it becomes selectable
        // again is derivable. Without a positive rate there is nothing to
        // derive; fall back to a bounded wait.
        const recoveryRate = healthTracker.getRecoveryRatePerHour();
        blockers.push(recoveryRate > 0
          ? Math.ceil(((minUsable - healthScore) / recoveryRate) * 3_600_000)
          : SOFT_QUOTA_UNKNOWN_WAIT_MS);
      }
      if (blockers.length > 0) waitTimes.push(Math.max(...blockers));
    }

    return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
  }

  /** One line per blocked account naming every active blocker (rate limit,
   * cooldown, soft quota), for error messages that must not blame the wrong
   * mechanism. Accounts with no active blocker are omitted. */
  describeAccountBlockers(
    family: ModelFamily,
    model: string | null | undefined,
    headerStyle: HeaderStyle | undefined,
    strict: boolean,
    eligible: (account: ManagedAccount) => boolean,
    softQuotaThresholdPercent: number,
    softQuotaCacheTtlMs: number,
  ): string[] {
    const now = nowMs();
    const healthTracker = getHealthTracker();
    const minUsable = healthTracker.getMinUsable();
    const lines: string[] = [];
    for (const a of this.accounts) {
      if (a.enabled === false || !eligible(a)) continue;
      const causes: string[] = [];
      if (family === "claude") {
        const t = a.rateLimitResetTimes.claude;
        if (t !== undefined && t > now) {
          causes.push(`claude quota rate-limited (resets in ${formatWaitTime(t - now)})`);
        }
      } else {
        const pools = strict && headerStyle ? [headerStyle] : (["antigravity", "gemini-cli"] as HeaderStyle[]);
        for (const style of pools) {
          const pending = [a.rateLimitResetTimes[getQuotaKey(family, style, model)], a.rateLimitResetTimes[getQuotaKey(family, style)]]
            .filter((t): t is number => t !== undefined && t > now);
          if (pending.length > 0) {
            causes.push(`${style} pool rate-limited (resets in ${formatWaitTime(Math.max(...pending) - now)})`);
          }
        }
      }
      if (a.coolingDownUntil !== undefined && a.coolingDownUntil > now) {
        causes.push(`cooling down after ${a.cooldownReason ?? "failure"} (${formatWaitTime(a.coolingDownUntil - now)} left)`);
      }
      const licenseBlockedUntil = a.licenseBlockedUntil?.[family];
      if (licenseBlockedUntil !== undefined && licenseBlockedUntil > now) {
        causes.push(`product license missing (${a.licenseBlockReason ?? "SUBSCRIPTION_REQUIRED"}, benched ${formatWaitTime(licenseBlockedUntil - now)})`);
      }
      if (softQuotaThresholdPercent < 100 && isOverSoftQuotaThreshold(a, family, softQuotaThresholdPercent, softQuotaCacheTtlMs, model)) {
        const groupData = a.cachedQuota?.[resolveQuotaGroup(family, model)];
        const entry = perModelQuotaEntry(groupData, model);
        const remaining = entry?.remainingFraction ?? groupData?.remainingFraction;
        const used = remaining === undefined ? "unknown" : `${((1 - remaining) * 100).toFixed(1)}%`;
        const resetTime = entry?.resetTime ?? groupData?.resetTime;
        causes.push(`over the ${softQuotaThresholdPercent}% soft quota threshold (used ${used}${resetTime ? `, resets ${formatResetStamp(resetTime)}` : ""})`);
      }
      const healthScore = healthTracker.getScore(a.index);
      if (healthScore < minUsable) {
        causes.push(`health score too low after failures (${healthScore}/100, min ${minUsable})`);
      }
      if (causes.length > 0) {
        lines.push(`${formatAccountLabel(a.email, a.index)}: ${causes.join("; ")}`);
      }
    }
    return lines;
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  async saveToDisk(): Promise<void> {
    // OAuth already in flight may rotate a token after retirement. V2 must
    // retain that credential without restoring any stale account controls.
    if (this.retired && !this.managedStorage) return;
    const credentialsOnly = this.retired;
    const saving = this.saveTail.then(() => this.persistToDisk(credentialsOnly));
    this.saveTail = saving.catch(() => undefined);
    this.activeSaves.add(saving);
    try {
      await saving;
    } finally {
      this.activeSaves.delete(saving);
    }
  }

  /** V2 menus own pool membership and controls. Transport writes are patches. */
  useManagedStorage(): void {
    if (this.managedStorage) return;
    this.managedStorage = true;
    for (const account of this.accounts) this.persistedAccounts.set(account.index, { ...account.parts, enabled: account.enabled, fingerprintID: account.fingerprint?.deviceId });
    for (const family of ["claude", "gemini"] as const) {
      const account = this.accounts[this.currentAccountIndexByFamily[family]];
      if (account) this.persistedSelections[family] = account.id ?? account.parts.refreshToken;
    }
  }

  private async persistManagedAccounts(credentialsOnly = false): Promise<void> {
    const snapshots = this.accounts.map(account => ({
      account,
      value: { ...account, parts: { ...account.parts }, rateLimitResetTimes: { ...account.rateLimitResetTimes } },
      base: this.persistedAccounts.get(account.index),
      sources: new Map(this.credentialSources.get(account.index)),
    }));
    const selections = { ...this.currentAccountIndexByFamily };
    const persistedSelections = { ...this.persistedSelections };
    const saved = await updateAccounts(storage => {
      for (const { value: account, base, sources } of snapshots) {
        if (!base) continue;
        const current = storage.accounts.find(item => account.id ? item.id === account.id : item.refreshToken === base.refreshToken);
        if (!current) continue;
        const source = sources.get(current.refreshToken) ?? (current.refreshToken === base.refreshToken ? base : undefined);
        if (source) {
          const parts: Partial<RefreshParts> = {};
          for (const key of ["refreshToken", "projectId", "managedProjectId"] as const) {
            if (current[key] === source[key] && account.parts[key] !== source[key] && account.parts[key] !== undefined) parts[key] = account.parts[key];
          }
          updateAccountCredentials(current, parts);
          if (!credentialsOnly && account.enabled !== base.enabled) {
            current.enabled = account.enabled;
            for (const key of ["verificationRequired", "verificationRequiredAt", "verificationRequiredReason", "verificationUrl"] as const) {
              Object.assign(current, { [key]: account[key] });
            }
          }
        }
        if (credentialsOnly) continue;
        const persistedLimits = current.rateLimitResetTimes;
        const cleared = this.clearedRateLimits.get(account.index);
        if (persistedLimits && cleared) {
          for (const [key, clearedReset] of cleared) {
            const persistedReset = persistedLimits[key];
            if (persistedReset !== undefined && persistedReset <= clearedReset) {
              delete persistedLimits[key];
            }
          }
        }
        current.lastUsed = Math.max(current.lastUsed, account.lastUsed);
        current.rateLimitResetTimes ??= {};
        for (const [key, reset] of Object.entries(account.rateLimitResetTimes)) {
          if (reset !== undefined) current.rateLimitResetTimes[key] = Math.max(current.rateLimitResetTimes[key] ?? 0, reset);
        }
        if ((account.coolingDownUntil ?? 0) > (current.coolingDownUntil ?? 0)) {
          current.coolingDownUntil = account.coolingDownUntil;
          current.cooldownReason = account.cooldownReason;
        }
        for (const family of ["claude", "gemini"] as const) {
          const until = account.licenseBlockedUntil?.[family];
          if (until !== undefined && until > (current.licenseBlockedUntil?.[family] ?? 0)) {
            current.licenseBlockedUntil ??= {};
            current.licenseBlockedUntil[family] = until;
            current.licenseBlockReason = account.licenseBlockReason;
          }
        }
        if ((account.cachedQuotaUpdatedAt ?? 0) > (current.cachedQuotaUpdatedAt ?? 0)) {
          current.cachedQuota = account.cachedQuota;
          current.cachedQuotaUpdatedAt = account.cachedQuotaUpdatedAt;
        }
        if (!current.fingerprint || account.fingerprint?.deviceId !== base.fingerprintID) {
          current.fingerprint = account.fingerprint;
          current.fingerprintHistory = account.fingerprintHistory;
        }
      }
      for (const family of ["claude", "gemini"] as const) {
        if (credentialsOnly) break;
        const selected = snapshots.find(snapshot => snapshot.value.index === selections[family])?.value;
        const current = storage.accounts[storage.activeIndexByFamily?.[family] ?? storage.activeIndex];
        const index = storage.accounts.findIndex(item => selected?.id ? item.id === selected.id : item.refreshToken === selected?.parts.refreshToken);
        if (selected && index >= 0 && storage.accounts[index]?.enabled !== false && current && (current.id ?? current.refreshToken) === persistedSelections[family]) {
          storage.activeIndexByFamily ??= {};
          storage.activeIndexByFamily[family] = index;
          if (family === "claude") storage.activeIndex = index;
        }
      }
    });
    // The merge above applied every recorded deletion; a failed write throws,
    // so reaching this point means the cleared markers are gone from disk.
    for (const snapshot of snapshots) {
      this.clearedRateLimits.delete(snapshot.value.index);
    }
    for (const { account, value: snapshot, base } of snapshots) {
      const current = saved?.accounts.find(item => account.id ? item.id === account.id : item.refreshToken === snapshot.parts.refreshToken);
      if (!current) { account.enabled = false; continue; }
      account.id ??= current.id;
      // Preserve OAuth/selection changes made while this snapshot was writing.
      // A different credential already committed by another manager wins.
      const externalRotation = current.refreshToken !== base?.refreshToken && current.refreshToken !== snapshot.parts.refreshToken && !this.credentialSources.get(account.index)?.has(current.refreshToken);
      const refreshToken = externalRotation || account.parts.refreshToken === snapshot.parts.refreshToken ? current.refreshToken : account.parts.refreshToken;
      if (refreshToken !== account.parts.refreshToken) {
        account.access = undefined;
        account.expires = undefined;
      }
      const parts = { ...account.parts, refreshToken };
      for (const key of ["projectId", "managedProjectId"] as const) {
        if (externalRotation || account.parts[key] === snapshot.parts[key] || (current[key] !== base?.[key] && current[key] !== snapshot.parts[key])) parts[key] = current[key];
      }
      account.parts = parts;
      if (account.parts.refreshToken === current.refreshToken && account.parts.projectId === current.projectId && account.parts.managedProjectId === current.managedProjectId) this.credentialSources.delete(account.index);
      const enabled = current.enabled !== false;
      if (account.enabled === snapshot.enabled || (enabled !== base?.enabled && enabled !== snapshot.enabled)) account.enabled = enabled;
      if (account.fingerprint === snapshot.fingerprint || (current.fingerprint?.deviceId !== base?.fingerprintID && current.fingerprint?.deviceId !== snapshot.fingerprint?.deviceId)) {
        account.fingerprint = current.fingerprint;
        account.fingerprintHistory = current.fingerprintHistory;
      }
      this.persistedAccounts.set(account.index, { refreshToken: current.refreshToken, projectId: current.projectId, managedProjectId: current.managedProjectId, enabled, fingerprintID: current.fingerprint?.deviceId });
    }
    for (const family of ["claude", "gemini"] as const) {
      const selected = this.accounts[this.currentAccountIndexByFamily[family]];
      const current = saved?.accounts[saved.activeIndexByFamily?.[family] ?? saved.activeIndex];
      if (selected && current && (selected.id ?? selected.parts.refreshToken) === (current.id ?? current.refreshToken)) this.persistedSelections[family] = current.id ?? current.refreshToken;
    }
  }

  private async persistToDisk(credentialsOnly = false): Promise<void> {
    if (this.managedStorage) return this.persistManagedAccounts(credentialsOnly);
    const claudeIndex = Math.max(0, this.currentAccountIndexByFamily.claude);
    const geminiIndex = Math.max(0, this.currentAccountIndexByFamily.gemini);
    
    const storage: AccountStorageV4 = {
      version: 4,
      accounts: this.accounts.map((a) => ({
        id: a.id,
        email: a.email,
        refreshToken: a.parts.refreshToken,
        projectId: a.parts.projectId,
        managedProjectId: a.parts.managedProjectId,
        addedAt: a.addedAt,
        lastUsed: a.lastUsed,
        enabled: a.enabled,
        lastSwitchReason: a.lastSwitchReason,
        rateLimitResetTimes: Object.keys(a.rateLimitResetTimes).length > 0 ? a.rateLimitResetTimes : undefined,
        coolingDownUntil: a.coolingDownUntil,
        cooldownReason: a.cooldownReason,
        fingerprint: a.fingerprint,
        fingerprintHistory: a.fingerprintHistory?.length ? a.fingerprintHistory : undefined,
        cachedQuota: a.cachedQuota && Object.keys(a.cachedQuota).length > 0 ? a.cachedQuota : undefined,
        cachedQuotaUpdatedAt: a.cachedQuotaUpdatedAt,
        licenseBlockedUntil: a.licenseBlockedUntil && Object.keys(a.licenseBlockedUntil).length > 0 ? a.licenseBlockedUntil : undefined,
        licenseBlockReason: a.licenseBlockReason,
        verificationRequired: a.verificationRequired,
        verificationRequiredAt: a.verificationRequiredAt,
        verificationRequiredReason: a.verificationRequiredReason,
        verificationUrl: a.verificationUrl,
      })),
      activeIndex: claudeIndex,
      activeIndexByFamily: {
        claude: claudeIndex,
        gemini: geminiIndex,
      },
    };

    await saveAccounts(storage);
  }

  requestSaveToDisk(): void {
    if (this.retired || this.savePending) {
      return;
    }
    this.savePending = true;
    this.saveTimeout = setTimeout(() => {
      void this.executeSave();
    }, 1000);
  }

  async flushSaveToDisk(): Promise<void> {
    if (!this.savePending) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.savePromiseResolvers.push(resolve);
    });
  }

  /** Drain existing writes and reject writes from requests using this old pool. */
  async retire(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    const finalSave = !this.retired && this.savePending ? this.executeSave() : undefined;
    this.retired = true;
    await Promise.allSettled([...this.activeSaves, ...(finalSave ? [finalSave] : [])]);
  }

  private async executeSave(): Promise<void> {
    this.savePending = false;
    this.saveTimeout = null;
    
    try {
      await this.saveToDisk();
    } catch {
      // best-effort persistence; avoid unhandled rejection from timer-driven saves
    } finally {
      const resolvers = this.savePromiseResolvers;
      this.savePromiseResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  // ========== Fingerprint Management ==========

  /**
   * Regenerate fingerprint for an account, saving the old one to history.
   * @param accountIndex - Index of the account to regenerate fingerprint for
   * @returns The new fingerprint, or null if account not found
   */
  regenerateAccountFingerprint(accountIndex: number): Fingerprint | null {
    const account = this.accounts[accountIndex];
    if (!account) return null;
    
    // Save current fingerprint to history if it exists
    if (account.fingerprint) {
      const historyEntry: FingerprintVersion = {
        fingerprint: account.fingerprint,
        timestamp: nowMs(),
        reason: 'regenerated',
      };
      
      if (!account.fingerprintHistory) {
        account.fingerprintHistory = [];
      }
      
      // Add to beginning of history (most recent first)
      account.fingerprintHistory.unshift(historyEntry);
      
      // Trim to max history size
      if (account.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory.slice(0, MAX_FINGERPRINT_HISTORY);
      }
    }

    // Generate and assign new fingerprint
    account.fingerprint = generateFingerprint();
    this.requestSaveToDisk();
    
    return account.fingerprint;
  }

  /**
   * Restore a fingerprint from history for an account.
   * @param accountIndex - Index of the account
   * @param historyIndex - Index in the fingerprint history to restore from (0 = most recent)
   * @returns The restored fingerprint, or null if account/history not found
   */
  restoreAccountFingerprint(accountIndex: number, historyIndex: number): Fingerprint | null {
    const account = this.accounts[accountIndex];
    if (!account) return null;

    const history = account.fingerprintHistory;
    if (!history || historyIndex < 0 || historyIndex >= history.length) {
      return null;
    }
    
    // Capture the fingerprint to restore BEFORE modifying history
    const fingerprintToRestore = history[historyIndex]!.fingerprint;
    
    // Save current fingerprint to history before restoring (if it exists)
    if (account.fingerprint) {
      const historyEntry: FingerprintVersion = {
        fingerprint: account.fingerprint,
        timestamp: nowMs(),
        reason: 'restored',
      };
      
      account.fingerprintHistory!.unshift(historyEntry);
      
      // Trim to max history size
      if (account.fingerprintHistory!.length > MAX_FINGERPRINT_HISTORY) {
        account.fingerprintHistory = account.fingerprintHistory!.slice(0, MAX_FINGERPRINT_HISTORY);
      }
    }

    // Restore the fingerprint
    account.fingerprint = { ...fingerprintToRestore, createdAt: nowMs() };
    
    this.requestSaveToDisk();
    
    return account.fingerprint;
  }

  /**
   * Get fingerprint history for an account.
   * @param accountIndex - Index of the account
   * @returns Array of fingerprint versions, or empty array if not found
   */
  getAccountFingerprintHistory(accountIndex: number): FingerprintVersion[] {
    const account = this.accounts[accountIndex];
    if (!account || !account.fingerprintHistory) {
      return [];
    }
    return [...account.fingerprintHistory];
  }

  updateQuotaCache(accountIndex: number, quotaGroups: Partial<Record<QuotaGroup, QuotaGroupSummary>>): void {
    const account = this.accounts[accountIndex];
    if (account) {
      account.cachedQuota = quotaGroups;
      account.cachedQuotaUpdatedAt = nowMs();
      if (this.reconcileRateLimitsWithQuota(account, quotaGroups)) {
        this.requestSaveToDisk();
      }
    }
  }

  /**
   * Drop rate-limit markers that fresh quota data contradicts.
   *
   * A marker records the earliest moment an account may be tried again, and a
   * quota 429 can carry a reset days away. When the backend later reports
   * remaining quota for the same group, the marker is stale state: keeping it
   * blocks an account that is actually usable until the old reset expires.
   *
   * Only keys the quota data can vouch for are removed. A model whose group is
   * exhausted, or that the response does not mention, keeps its marker.
   *
   * @returns true when at least one marker was removed
   */
  private reconcileRateLimitsWithQuota(
    account: ManagedAccount,
    quotaGroups: Partial<Record<QuotaGroup, QuotaGroupSummary>>,
  ): boolean {
    const claudeAvailable = groupHasAvailableQuota(quotaGroups.claude);
    const geminiAvailable =
      groupHasAvailableQuota(quotaGroups["gemini-pro"]) ||
      groupHasAvailableQuota(quotaGroups["gemini-flash"]);
    if (!claudeAvailable && !geminiAvailable) {
      return false;
    }

    let changed = false;
    for (const key of Object.keys(account.rateLimitResetTimes) as QuotaKey[]) {
      const family = familyForQuotaKey(key);
      if (!family) continue;
      if (family === "claude" ? !claudeAvailable : !geminiAvailable) continue;

      const model = modelForQuotaKey(key);
      if (model) {
        const quotaGroup = getModelFamily(model);
        if (quotaGroup === "claude" ? !claudeAvailable : !modelHasAvailableQuota(quotaGroups[quotaGroup], model)) {
          continue;
        }
      }

      const resetTime = account.rateLimitResetTimes[key];
      if (resetTime === undefined) continue;
      delete account.rateLimitResetTimes[key];
      let cleared = this.clearedRateLimits.get(account.index);
      if (!cleared) {
        cleared = new Map();
        this.clearedRateLimits.set(account.index, cleared);
      }
      cleared.set(key, resetTime);
      changed = true;
    }
    return changed;
  }

  isAccountOverSoftQuota(account: ManagedAccount, family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null): boolean {
    return isOverSoftQuotaThreshold(account, family, thresholdPercent, cacheTtlMs, model);
  }

  getAccountsForQuotaCheck(): AccountMetadataV3[] {
    return this.accounts.map((a) => ({
      id: a.id,
      email: a.email,
      refreshToken: a.parts.refreshToken,
      projectId: a.parts.projectId,
      managedProjectId: a.parts.managedProjectId,
      addedAt: a.addedAt,
      lastUsed: a.lastUsed,
      enabled: a.enabled,
    }));
  }

  getOldestQuotaCacheAge(): number | null {
    let oldest: number | null = null;
    for (const acc of this.accounts) {
      if (acc.enabled === false) continue;
      if (acc.cachedQuotaUpdatedAt == null) return null;
      const age = nowMs() - acc.cachedQuotaUpdatedAt;
      if (oldest === null || age > oldest) oldest = age;
    }
    return oldest;
  }

  areAllAccountsOverSoftQuota(family: ModelFamily, thresholdPercent: number, cacheTtlMs: number, model?: string | null, eligible: (account: ManagedAccount) => boolean = () => true): boolean {
    if (thresholdPercent >= 100) return false;
    const enabled = this.accounts.filter(a => a.enabled !== false && eligible(a));
    if (enabled.length === 0) return false;
    return enabled.every(a => isOverSoftQuotaThreshold(a, family, thresholdPercent, cacheTtlMs, model));
  }

  /**
   * Get minimum wait time until any account's soft quota resets.
   * Returns 0 if any account is available (not over threshold).
   * Returns the minimum resetTime across all over-threshold accounts.
   * Returns null if no resetTime data is available.
   */
  getMinWaitTimeForSoftQuota(
    family: ModelFamily,
    thresholdPercent: number,
    cacheTtlMs: number,
    model?: string | null,
    eligible: (account: ManagedAccount) => boolean = () => true,
  ): number | null {
    if (thresholdPercent >= 100) return 0;
    
    const enabled = this.accounts.filter(a => a.enabled !== false && eligible(a));
    if (enabled.length === 0) return null;
    
    // If any account is available (not over threshold), no wait needed
    const available = enabled.filter(a => !isOverSoftQuotaThreshold(a, family, thresholdPercent, cacheTtlMs, model));
    if (available.length > 0) return 0;
    
    // All accounts are over threshold - find earliest reset time
    // For gemini family, we MUST have the model to distinguish pro vs flash quotas.
    // Fail-open (return null = no wait info) if model is missing to avoid blocking on wrong quota.
    if (!model && family !== "claude") return null;
    const quotaGroup = resolveQuotaGroup(family, model);
    const now = nowMs();
    const waitTimes: number[] = [];
    
    for (const acc of enabled) {
      const groupData = acc.cachedQuota?.[quotaGroup];
      const resetTime = perModelQuotaEntry(groupData, model)?.resetTime ?? groupData?.resetTime;
      if (resetTime) {
        const resetTimestamp = Date.parse(resetTime);
        if (Number.isFinite(resetTimestamp)) {
          waitTimes.push(Math.max(0, resetTimestamp - now));
        }
      }
    }
    
    if (waitTimes.length === 0) return null;
    const minWait = Math.min(...waitTimes);
    // Treat 0 as stale cache (resetTime in the past) → fail-open to avoid spin loop
    return minWait === 0 ? null : minWait;
  }
}
