import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_PROD,
  getAntigravityUserAgent,
  getRandomizedHeaders,
  ANTIGRAVITY_PROVIDER_ID,
} from "../constants";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import { logQuotaFetch, logQuotaStatus, debugLogToFile } from "./debug";
import { ensureProjectContext } from "./project";
import { refreshAccessToken } from "./token";
import { getModelFamily } from "./transform/model-resolver";
import type { PluginClient, OAuthAuthDetails } from "./types";
import type { AccountMetadataV3 } from "./storage";

const FETCH_TIMEOUT_MS = 10000;

/**
 * Total wall-clock budget for one quota sweep across every account. The TUI
 * aborts and replaces the server whenever its event stream stays idle for 45 s,
 * so a sweep must always finish - or give up on the remaining accounts - well
 * inside that window.
 */
const SWEEP_BUDGET_MS = 20000;

export type QuotaGroup = "claude" | "gemini-pro" | "gemini-flash" | "gemini-argon";

export interface QuotaModelSummary {
  remainingFraction?: number;
  resetTime?: string;
}

export interface QuotaGroupSummary {
  remainingFraction?: number;
  resetTime?: string;
  weeklyRemainingFraction?: number;
  weeklyResetTime?: string;
  modelCount: number;
  /** Remaining quota per model when the backend reports quotaInfo per model.
   * Account selection prefers the requested model's own entry over the group
   * minimum, so one depleted model no longer blocks the whole group. */
  models?: Record<string, QuotaModelSummary>;
}

/** Check if quota groups indicate a Pro-tier account (Argon weekly bucket or 5.5 model series). */
export function isProQuotaGroup(groups?: Partial<Record<QuotaGroup, QuotaGroupSummary>> | null): boolean {
  if (!groups) return false;
  if (groups["gemini-argon"]) return true;
  return Object.values(groups).some(g =>
    Object.keys(g?.models ?? {}).some(m => m.includes("5-5") || m.includes("argon")),
  );
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  modelCount: number;
  models?: Record<string, AvailableModel>;
  error?: string;
}

// Gemini CLI quota types
export interface GeminiCliQuotaModel {
  modelId: string;
  remainingFraction: number;
  resetTime?: string;
}

export interface GeminiCliQuotaSummary {
  models: GeminiCliQuotaModel[];
  error?: string;
}

interface RetrieveUserQuotaResponse {
  buckets?: {
    remainingAmount?: string;
    remainingFraction?: number;
    resetTime?: string;
    tokenType?: string;
    modelId?: string;
  }[];
}

export type AccountQuotaStatus = "ok" | "disabled" | "error";

export interface AccountQuotaResult {
  index: number;
  email?: string;
  status: AccountQuotaStatus;
  error?: string;
  disabled?: boolean;
  quota?: QuotaSummary;
  geminiCliQuota?: GeminiCliQuotaSummary;
  updatedAccount?: AccountMetadataV3;
}

export interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>;
  agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>;
  tieredModelIds?: Record<string, string[]>;
}

export interface AvailableModel {
  displayName?: string;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  disabled?: boolean;
  selectable?: boolean;
}

interface FetchAvailableModelEntry extends AvailableModel {
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
  displayName?: string;
  modelName?: string;
}

function buildAuthFromAccount(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: undefined,
    expires: undefined,
  };
}

function normalizeRemainingFraction(value: unknown): number {
  // If value is missing or invalid, treat as exhausted (0%)
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null;
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}

/**
 * Gemini 4 Argon draws from its own weekly-only bucket, separate from the
 * shared Gemini pool (see Google's account dashboard), so its quota must not be
 * min-merged into the pro or flash groups. Model names and display names are
 * both checked, and callers must keep the claude branch ahead of this one.
 */
export function isArgonModelName(value: string): boolean {
  return value.toLowerCase().includes("argon");
}

function classifyQuotaGroup(modelName: string, displayName?: string): QuotaGroup | null {
  const combined = `${modelName} ${displayName ?? ""}`.toLowerCase();
  if (combined.includes("claude")) {
    return "claude";
  }
  if (!combined.includes("gemini")) {
    return null;
  }
  if (isArgonModelName(combined)) {
    return "gemini-argon";
  }
  const family = getModelFamily(modelName);
  return family === "gemini-flash" ? "gemini-flash" : "gemini-pro";
}

export function aggregateQuota(models?: Record<string, FetchAvailableModelEntry>, selectable?: Set<string>): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {};
  const perModel: Partial<Record<QuotaGroup, Record<string, QuotaModelSummary>>> = {};
  const catalog: Record<string, AvailableModel> = {};
  if (!models) {
    return { groups, modelCount: 0 };
  }

  let totalCount = 0;
  for (const [modelName, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    // Keep only catalog metadata. API experiments can contain unrelated prompts.
    catalog[modelName] = {
      displayName: entry.displayName,
      maxTokens: entry.maxTokens,
      maxOutputTokens: entry.maxOutputTokens,
      supportsImages: entry.supportsImages,
      supportsThinking: entry.supportsThinking,
      disabled: entry.disabled,
      selectable: selectable ? selectable.has(modelName) : undefined,
    };
    if (entry.disabled) continue;
    const group = classifyQuotaGroup(modelName, entry.displayName ?? entry.modelName);
    if (!group) {
      continue;
    }
    const quotaInfo = entry.quotaInfo;
    const remainingFraction = quotaInfo
      ? normalizeRemainingFraction(quotaInfo.remainingFraction)
      : undefined;
    const resetTime = quotaInfo?.resetTime;
    const resetTimestamp = parseResetTime(resetTime);

    totalCount += 1;

    const existing = groups[group];
    const nextCount = (existing?.modelCount ?? 0) + 1;
    const nextRemaining =
      remainingFraction === undefined
        ? existing?.remainingFraction
        : existing?.remainingFraction === undefined
          ? remainingFraction
          : Math.min(existing.remainingFraction, remainingFraction);

    let nextResetTime = existing?.resetTime;
    if (resetTimestamp !== null) {
      if (!existing?.resetTime) {
        nextResetTime = resetTime;
      } else {
        const existingTimestamp = parseResetTime(existing.resetTime);
        if (existingTimestamp === null || resetTimestamp < existingTimestamp) {
          nextResetTime = resetTime;
        }
      }
    }

    const modelSummaries = (perModel[group] ??= {});
    const modelSummary: QuotaModelSummary = {};
    if (remainingFraction !== undefined) modelSummary.remainingFraction = remainingFraction;
    if (resetTime) modelSummary.resetTime = resetTime;
    modelSummaries[modelName] = modelSummary;

    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount,
      models: modelSummaries,
    };
  }

  return { groups, modelCount: totalCount, models: catalog };
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
): Promise<FetchAvailableModelsResponse> {
  // Antigravity quota comes from the same host and Hub User-Agent as content requests.
  const endpoint = ANTIGRAVITY_ENDPOINT;
  const quotaUserAgent = getAntigravityUserAgent();
  const errors: string[] = [];

  const body = projectId ? { project: projectId } : {};
  const response = await fetchWithTimeout(`${endpoint}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": quotaUserAgent,
    },
    body: JSON.stringify(body),
  });

  if (response.ok) {
    return (await response.json()) as FetchAvailableModelsResponse;
  }

  const message = await response.text().catch(() => "");
  const snippet = message.trim().slice(0, 200);
  errors.push(
    `fetchAvailableModels ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`,
  );

  throw new Error(errors.join("; ") || "fetchAvailableModels failed");
}

interface RetrieveUserQuotaSummaryResponse {
  groups?: {
    displayName?: string;
    description?: string;
    buckets?: {
      bucketId?: string;
      displayName?: string;
      window?: string;
      resetTime?: string;
      description?: string;
      remainingFraction?: number;
    }[];
  }[];
}

async function fetchUserQuotaSummary(
  accessToken: string,
  projectId: string,
): Promise<RetrieveUserQuotaSummaryResponse | undefined> {
  const endpoint = ANTIGRAVITY_ENDPOINT;
  const quotaUserAgent = getAntigravityUserAgent();
  const body = projectId ? { project: projectId } : {};

  try {
    const response = await fetchWithTimeout(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": quotaUserAgent,
        "X-Opencode-Client": "cli",
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return (await response.json()) as RetrieveUserQuotaSummaryResponse;
    }
    return undefined;
  } catch (error: unknown) {
    debugLogToFile(`[Quota] fetchUserQuotaSummary failed: ${String(error)}`);
    return undefined;
  }
}

async function fetchGeminiCliQuota(
  accessToken: string,
  projectId: string,
): Promise<RetrieveUserQuotaResponse> {
  const endpoint = ANTIGRAVITY_ENDPOINT_PROD;
  const body = projectId ? { project: projectId } : {};
  
  try {
    const response = await fetchWithTimeout(`${endpoint}/v1internal:retrieveUserQuota`, {
      method: "POST",
      headers: {
        ...getRandomizedHeaders("gemini-cli"),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = (await response.json()) as RetrieveUserQuotaResponse;
      return data;
    }

    // Non-OK response - return empty buckets
    return { buckets: [] };
  } catch {
    // Network error or timeout - return empty buckets
    return { buckets: [] };
  }
}

function aggregateGeminiCliQuota(response: RetrieveUserQuotaResponse): GeminiCliQuotaSummary {
  const models: GeminiCliQuotaModel[] = [];
  
  if (!response.buckets || response.buckets.length === 0) {
    return { models };
  }

  for (const bucket of response.buckets) {
    if (!bucket.modelId) {
      continue;
    }
    
    // Keep the model versions returned by Google instead of a dated allowlist.
    const modelId = bucket.modelId;
    if (!modelId.startsWith("gemini-")) {
      continue;
    }
    
    models.push({
      modelId: bucket.modelId,
      remainingFraction: normalizeRemainingFraction(bucket.remainingFraction),
      resetTime: bucket.resetTime,
    });
  }

  // Sort by model ID for consistent display
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));

  return { models };
}

function applyAccountUpdates(account: AccountMetadataV3, auth: OAuthAuthDetails): AccountMetadataV3 | undefined {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  const updated: AccountMetadataV3 = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
  };

  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId;

  return changed ? updated : undefined;
}

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
  options: {
    includeDisabled?: boolean;
    onAccountUpdated?: (original: AccountMetadataV3, updated: AccountMetadataV3) => Promise<unknown>;
    signal?: AbortSignal;
    concurrency?: number;
  } = {},
): Promise<AccountQuotaResult[]> {
  logQuotaFetch("start", accounts.length);

  const sweepDeadline = Date.now() + SWEEP_BUDGET_MS;
  const CONCURRENCY = Math.max(1, Math.min(options.concurrency ?? 4, accounts.length));
  const results: AccountQuotaResult[] = new Array(accounts.length);
  let nextAccountIndex = 0;

  async function worker() {
    while (true) {
      if (options.signal?.aborted) break;
      const currentIndex = nextAccountIndex++;
      if (currentIndex >= accounts.length) break;

      const account = accounts[currentIndex]!;
      const disabled = account.enabled === false;
      if (disabled && options.includeDisabled !== true) {
        results[currentIndex] = { index: currentIndex, email: account.email, status: "disabled", disabled: true };
        continue;
      }

      if (Date.now() > sweepDeadline) {
        results[currentIndex] = {
          index: currentIndex,
          email: account.email,
          status: "error",
          disabled,
          error: `Quota sweep budget of ${SWEEP_BUDGET_MS} ms exceeded; account not checked`,
        };
        continue;
      }

      let auth = buildAuthFromAccount(account);
      let updatedAccount: AccountMetadataV3 | undefined;

      try {
        if (options.signal?.aborted) throw options.signal.reason;
        if (accessTokenExpired(auth)) {
          const refreshed = await refreshAccessToken(auth, client, providerId);
          if (!refreshed) {
            throw new Error("Token refresh failed");
          }
          auth = refreshed;
        }

        updatedAccount = applyAccountUpdates(account, auth);
        if (updatedAccount) await options.onAccountUpdated?.(account, updatedAccount);
        if (options.signal?.aborted) throw options.signal.reason;
        const beforeProject = updatedAccount ?? account;
        const projectContext = await ensureProjectContext(auth);
        auth = projectContext.auth;
        updatedAccount = applyAccountUpdates(account, auth);
        const projectUpdates = applyAccountUpdates(beforeProject, auth);
        if (projectUpdates) await options.onAccountUpdated?.(beforeProject, projectUpdates);
        if (options.signal?.aborted) throw options.signal.reason;

        let quotaResult: QuotaSummary;
        let geminiCliQuotaResult: GeminiCliQuotaSummary;
        
        // Fetch Antigravity models, Gemini CLI quotas, and user quota summary in parallel
        const [antigravityResponse, geminiCliResponse, userQuotaSummary] = await Promise.all([
          fetchAvailableModels(auth.access ?? "", projectContext.effectiveProjectId)
            .catch((error): FetchAvailableModelsResponse => ({ models: undefined })),
          fetchGeminiCliQuota(auth.access ?? "", projectContext.effectiveProjectId),
          fetchUserQuotaSummary(auth.access ?? "", projectContext.effectiveProjectId),
        ]);

        // Process Antigravity quota
        if (antigravityResponse.models === undefined) {
          quotaResult = {
            groups: {},
            modelCount: 0,
            error: "Failed to fetch Antigravity quota",
          };
        } else {
          const visible = (antigravityResponse.agentModelSorts ?? []).flatMap(sort => (sort.groups ?? []).flatMap(group => group.modelIds ?? []));
          // The backend also exposes obsolete aliases, completion models, and
          // routing IDs. Prefer the same selectable inventory as Antigravity.
          const selectable = visible.length ? new Set([...visible, ...Object.values(antigravityResponse.tieredModelIds ?? {}).flat()]) : undefined;
          quotaResult = aggregateQuota(antigravityResponse.models, selectable);

          // Merge accurate multi-tier (5h vs weekly) windows from retrieveUserQuotaSummary
          if (userQuotaSummary?.groups) {
            for (const group of userQuotaSummary.groups) {
              const displayName = (group.displayName ?? "").toLowerCase();
              let targetKey: QuotaGroup | undefined;
              if (displayName.includes("claude") || displayName.includes("gpt")) {
                targetKey = "claude";
              } else if (displayName.includes("gemini 4 argon") || displayName.includes("argon")) {
                targetKey = "gemini-argon";
              } else if (displayName.includes("gemini")) {
                targetKey = "gemini-flash";
              }

              if (targetKey && quotaResult.groups[targetKey]) {
                const targetGroup = quotaResult.groups[targetKey]!;
                for (const bucket of group.buckets ?? []) {
                  if (bucket.window === "5h" || (bucket.displayName ?? "").toLowerCase().includes("five hour")) {
                    if (bucket.remainingFraction !== undefined) {
                      targetGroup.remainingFraction = normalizeRemainingFraction(bucket.remainingFraction);
                    }
                    if (bucket.resetTime) {
                      targetGroup.resetTime = bucket.resetTime;
                    }
                  } else if (bucket.window === "weekly" || (bucket.displayName ?? "").toLowerCase().includes("weekly")) {
                    if (bucket.remainingFraction !== undefined) {
                      targetGroup.weeklyRemainingFraction = normalizeRemainingFraction(bucket.remainingFraction);
                    }
                    if (bucket.resetTime) {
                      targetGroup.weeklyResetTime = bucket.resetTime;
                    }
                  }
                }
              }
            }
          }
        }

        // Process Gemini CLI quota
        geminiCliQuotaResult = aggregateGeminiCliQuota(geminiCliResponse);
        if (geminiCliResponse.buckets === undefined || geminiCliResponse.buckets.length === 0) {
          geminiCliQuotaResult.error = geminiCliQuotaResult.models.length === 0 
            ? "No Gemini CLI quota available" 
            : undefined;
        }

        results[currentIndex] = {
          index: currentIndex,
          email: account.email,
          status: "ok",
          disabled,
          quota: quotaResult,
          geminiCliQuota: geminiCliQuotaResult,
          updatedAccount,
        };
        
        // Log quota status for each family
        for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
          const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100;
          logQuotaStatus(account.email, currentIndex, remainingPercent, family);
        }
      } catch (error) {
        results[currentIndex] = {
          index: currentIndex,
          email: account.email,
          status: "error",
          updatedAccount,
          disabled,
          error: error instanceof Error ? error.message : String(error),
        };
        logQuotaFetch("error", undefined, `account=${account.email ?? currentIndex} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  logQuotaFetch("complete", accounts.length, `ok=${results.filter(r => r.status === "ok").length} errors=${results.filter(r => r.status === "error").length}`);
  return results;
}
