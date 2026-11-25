import type { ProviderModel } from "../types";

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Thinking budget that stands in for the `xhigh` tier on the providerOptions
 * channel. OpenCode validates providerOptions.google.thinkingConfig.thinkingLevel
 * against @ai-sdk/google's enum, which stops at "high", so a variant cannot name
 * the highest tier there. The plugin emits this budget instead and maps it back
 * to the "xhigh" level for the Antigravity request, where the backend accepts it.
 */
export const XHIGH_TIER_BUDGET = 65536;

export interface ModelThinkingConfig {
  thinkingBudget: number;
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel;
  thinkingConfig?: ModelThinkingConfig;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export type ModelModality = "text" | "image" | "pdf";

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface OpencodeModelDefinition extends ProviderModel {
  name: string;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
  proTier?: boolean;
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;

/**
 * Canonical Antigravity quota bucket identifiers.
 * Add or remove bucket IDs here and configure matching rules in
 * `QUOTA_BUCKET_REGISTRY` (or per-model `quotaGroup` overrides on entries below)
 * to change bucket routing across quota aggregation, soft-quota checks,
 * account rotation, and CLI display without touching downstream consumers.
 */
export type QuotaGroupId = "claude" | "gemini";

export interface QuotaBucketDescriptor {
  id: QuotaGroupId;
  /** Human-readable label shown in CLI quota status. */
  label: string;
  /** Rate-limit / sticky-cursor family used by AccountManager. */
  modelFamily: "claude" | "gemini";
  /** True when Pro/Ultra accounts expose both 5h and 1w windows for this bucket. */
  twoTierOnPro: boolean;
  /** Patterns matched against retrieveUserQuotaSummary group displayNames. */
  summaryDisplayMatchers: readonly RegExp[];
  /** Fallback patterns matched against `<modelId> <displayName>` when no explicit override exists. */
  defaultModelMatchers: readonly RegExp[];
}

export const QUOTA_BUCKET_REGISTRY: readonly QuotaBucketDescriptor[] = [
  {
    id: "claude",
    label: "Claude",
    modelFamily: "claude",
    twoTierOnPro: true,
    summaryDisplayMatchers: [/claude/i, /\bgpt\b/i],
    defaultModelMatchers: [/claude/i, /\bgpt-oss\b/i],
  },
  {
    id: "gemini",
    label: "Gemini",
    modelFamily: "gemini",
    twoTierOnPro: true,
    summaryDisplayMatchers: [/gemini/i],
    defaultModelMatchers: [/gemini/i],
  },
];

export const QUOTA_BUCKET_ORDER: readonly QuotaGroupId[] = QUOTA_BUCKET_REGISTRY.map(bucket => bucket.id);
export const QUOTA_BUCKET_BY_ID: ReadonlyMap<QuotaGroupId, QuotaBucketDescriptor> = new Map(
  QUOTA_BUCKET_REGISTRY.map(bucket => [bucket.id, bucket]),
);

/**
 * Scheduled removal metadata for models Antigravity is sunsetting.
 * Flip `retired` to `true` (or delete the entry and add its normalized base ID
 * to `RETIRED_MODEL_BASES`) to remove a model across static definitions, V2
 * fallback, dynamic catalog discovery, tier-suffix seeding, and legacy aliases.
 */
export interface ModelSunsetMetadata {
  /** ISO date (YYYY-MM-DD) when Antigravity removes this model. */
  removalDate: string;
  /** Account tier(s) affected by the removal. */
  scope: "all" | "pro" | "free";
  /** When true, the model is excluded everywhere in the plugin. */
  retired: boolean;
}

export interface ManagedModelEntry {
  definition: OpencodeModelDefinition;
  /**
   * Optional explicit quota bucket override for this model.
   * When omitted, bucket routing falls back to `QUOTA_BUCKET_REGISTRY` matchers.
   */
  quotaGroup?: QuotaGroupId;
  /** Include in V2 pre-discovery fallback catalog. */
  v2Fallback?: boolean;
  /**
   * True when the Antigravity catalog only publishes per-tier IDs
   * (`<base>-<tier>`) with no bare base ID, so requests must rewrite to the
   * selected tier suffix and preserve those backend IDs verbatim.
   */
  perTierBackendIds?: boolean;
  /**
   * True for legacy non-thinking Claude IDs that should drop thinkingConfig
   * unless Google's live catalog marks them as thinking-capable.
   */
  nonThinkingFallback?: boolean;
  /** Legacy proxy aliases mapping to this model's backend ID. */
  aliases?: Record<string, string>;
  /** Deprecation metadata for leaving-soon models. */
  sunset?: ModelSunsetMetadata;
}

/**
 * Discovered-only models without static OpenCode definitions that still need
 * advertised tier-suffix preservation, bucket routing, or retirement tracking.
 */
export interface DiscoveredOnlyModelEntry {
  /** Exact backend ID (e.g. "gpt-oss-120b-medium"). */
  id: string;
  /** Optional explicit quota bucket override for this model. */
  quotaGroup?: QuotaGroupId;
  /** Keep the trailing tier-like suffix verbatim in model-resolver. */
  advertisedTierSuffix?: boolean;
  sunset?: ModelSunsetMetadata;
}

const DEFAULT_MODALITIES: ModelModalities = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

const TIER_SUFFIX_REGEX = /-(minimal|low|medium|high|xhigh)$/i;

/**
 * Normalizes a model or catalog key to its canonical lowercase base ID by
 * stripping a leading `antigravity-` prefix, a trailing thinking-tier suffix,
 * and an optional `-thinking` decoration.
 */
export function normalizeModelBase(modelId: string): string {
  return modelId
    .replace(/^antigravity-/i, "")
    .replace(TIER_SUFFIX_REGEX, "")
    .replace(/-thinking$/i, "")
    .toLowerCase();
}

/**
 * Active Antigravity and Gemini CLI model definitions.
 */
export const ACTIVE_MANAGED_MODELS: Readonly<Record<string, ManagedModelEntry>> = {
  "antigravity-gemini-3-pro": {
    definition: {
      name: "Gemini 3 Pro (Antigravity)",
      limit: { context: 1048576, output: 65535 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { thinkingLevel: "low" },
        high: { thinkingLevel: "high" },
      },
    },
  },
  "antigravity-gemini-3.1-pro": {
    definition: {
      name: "Gemini 3.1 Pro (Antigravity)",
      limit: { context: 1048576, output: 65535 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { thinkingLevel: "low" },
        high: { thinkingLevel: "high" },
      },
    },
  },
  "antigravity-gemini-3-flash": {
    v2Fallback: true,
    definition: {
      name: "Gemini 3 Flash (Antigravity)",
      limit: { context: 1048576, output: 65536 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        minimal: { thinkingLevel: "minimal" },
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      },
    },
  },
  // Available to paid Pro and Ultra subscribers. The catalog advertises three
  // per-tier IDs (gemini-4-carbon-low/medium/high) and no bare ID.
  "antigravity-gemini-4-carbon": {
    v2Fallback: true,
    perTierBackendIds: true,
    definition: {
      name: "Gemini 4 Carbon (Antigravity)",
      limit: { context: 1048576, output: 262144 },
      modalities: DEFAULT_MODALITIES,
      proTier: true,
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      },
    },
  },
  // The catalog advertises Gemini 4 Hydrogen as four per-tier IDs
  // (gemini-4-hydrogen-low/medium/high/xhigh) and a disabled bare ID.
  "antigravity-gemini-4-hydrogen": {
    v2Fallback: true,
    perTierBackendIds: true,
    definition: {
      name: "Gemini 4 Hydrogen (Antigravity)",
      limit: { context: 1048576, output: 262144 },
      modalities: DEFAULT_MODALITIES,
      proTier: true,
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
        xhigh: { thinkingLevel: "xhigh" },
      },
    },
  },
  // The catalog advertises Gemini 4 Neon as four per-tier IDs
  // (gemini-4-neon-low/medium/high/xhigh).
  "antigravity-gemini-4-neon": {
    v2Fallback: true,
    perTierBackendIds: true,
    definition: {
      name: "Gemini 4 Neon (Antigravity)",
      limit: { context: 1048576, output: 262144 },
      modalities: DEFAULT_MODALITIES,
      proTier: true,
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
        xhigh: { thinkingLevel: "xhigh" },
      },
    },
  },
  "antigravity-claude-sonnet-5-5": {
    v2Fallback: true,
    perTierBackendIds: true,
    definition: {
      name: "Claude Sonnet 5.5 (Antigravity)",
      limit: { context: 200000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      proTier: true,
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      },
    },
  },
  "antigravity-claude-opus-5-5": {
    v2Fallback: true,
    perTierBackendIds: true,
    definition: {
      name: "Claude Opus 5.5 (Antigravity)",
      limit: { context: 200000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      proTier: true,
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      },
    },
  },
  "antigravity-claude-opus-5-5-thinking": {
    v2Fallback: true,
    definition: {
      name: "Claude Opus 5.5 Thinking (Antigravity)",
      limit: { context: 200000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      proTier: true,
      variants: {
        low: { thinkingConfig: { thinkingBudget: 8192 } },
        max: { thinkingConfig: { thinkingBudget: 32768 } },
      },
    },
  },
  "gemini-2.5-flash": {
    definition: {
      name: "Gemini 2.5 Flash (Gemini CLI)",
      limit: { context: 1048576, output: 65536 },
      modalities: DEFAULT_MODALITIES,
    },
  },
  "gemini-2.5-pro": {
    definition: {
      name: "Gemini 2.5 Pro (Gemini CLI)",
      limit: { context: 1048576, output: 65536 },
      modalities: DEFAULT_MODALITIES,
    },
  },
  "gemini-3-flash-preview": {
    definition: {
      name: "Gemini 3 Flash Preview (Gemini CLI)",
      limit: { context: 1048576, output: 65536 },
      modalities: DEFAULT_MODALITIES,
    },
  },
  "gemini-3-pro-preview": {
    definition: {
      name: "Gemini 3 Pro Preview (Gemini CLI)",
      limit: { context: 1048576, output: 65535 },
      modalities: DEFAULT_MODALITIES,
    },
  },
  "gemini-3.1-pro-preview": {
    definition: {
      name: "Gemini 3.1 Pro Preview (Gemini CLI)",
      limit: { context: 1048576, output: 65535 },
      modalities: DEFAULT_MODALITIES,
    },
  },
  "gemini-3.1-pro-preview-customtools": {
    definition: {
      name: "Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)",
      limit: { context: 1048576, output: 65535 },
      modalities: DEFAULT_MODALITIES,
    },
  },
};

/**
 * Antigravity models scheduled for removal on 2026-11-30.
 *
 * To remove any model once Google drops it, flip `sunset.retired` to `true`
 * (or delete its entry and add its base ID to `RETIRED_MODEL_BASES`). All
 * downstream catalogs, fallback lists, discovery filters, tier-suffix maps,
 * advertised IDs, and legacy aliases update automatically.
 */
export const SUNSET_MANAGED_MODELS: Readonly<Record<string, ManagedModelEntry>> = {
  "antigravity-gemini-3.8-flash": {
    v2Fallback: true,
    perTierBackendIds: true,
    sunset: { removalDate: "2026-11-30", scope: "all", retired: false },
    definition: {
      name: "Gemini 3.8 Flash (Antigravity)",
      limit: { context: 1048576, output: 65536 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      },
    },
  },
  "antigravity-claude-sonnet-4-6": {
    v2Fallback: true,
    nonThinkingFallback: true,
    aliases: {
      "gemini-claude-sonnet-4-6": "claude-sonnet-4-6",
    },
    sunset: { removalDate: "2026-11-30", scope: "free", retired: false },
    definition: {
      name: "Claude Sonnet 4.6 (Antigravity)",
      limit: { context: 200000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
    },
  },
  "antigravity-claude-opus-4-6-thinking": {
    v2Fallback: true,
    aliases: {
      "gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
      "gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
      "gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
    },
    sunset: { removalDate: "2026-11-30", scope: "free", retired: false },
    definition: {
      name: "Claude Opus 4.6 Thinking (Antigravity)",
      limit: { context: 200000, output: 64000 },
      modalities: DEFAULT_MODALITIES,
      variants: {
        low: { thinkingConfig: { thinkingBudget: 8192 } },
        max: { thinkingConfig: { thinkingBudget: 32768 } },
      },
    },
  },
  "antigravity-gemini-4-argon": {
    v2Fallback: true,
    perTierBackendIds: true,
    sunset: { removalDate: "2026-11-30", scope: "pro", retired: false },
    definition: {
      name: "Gemini 4 Argon (Antigravity)",
      limit: { context: 1048576, output: 65535 },
      modalities: DEFAULT_MODALITIES,
      proTier: true,
      variants: {
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      },
    },
  },
};

/**
 * Discovered-only Antigravity models scheduled for removal on 2026-11-30.
 */
export const SUNSET_DISCOVERED_MODELS: readonly DiscoveredOnlyModelEntry[] = [
  {
    id: "gpt-oss-120b-medium",
    quotaGroup: "claude",
    advertisedTierSuffix: true,
    sunset: { removalDate: "2026-11-30", scope: "all", retired: false },
  },
];

/**
 * Normalized base IDs permanently removed from Antigravity.
 * When deleting a retired entry from `SUNSET_MANAGED_MODELS` or
 * `SUNSET_DISCOVERED_MODELS`, keep its base ID here so stale catalog caches or
 * lingering API entries stay filtered out.
 */
export const RETIRED_MODEL_BASES: ReadonlySet<string> = new Set([
  // Example after removal: "gemini-4-argon", "gemini-3.8-flash", "gpt-oss-120b"
]);

export interface ModelRegistryViews {
  definitions: OpencodeModelDefinitions;
  v2FallbackIds: readonly string[];
  proTierBases: ReadonlySet<string>;
  retiredBases: ReadonlySet<string>;
  tierSuffixFamilies: ReadonlyArray<readonly [string, readonly ModelThinkingLevel[]]>;
  advertisedTierSuffixIds: readonly string[];
  aliases: Readonly<Record<string, string>>;
  nonThinkingClaudeFallbackIds: ReadonlySet<string>;
  quotaGroupsByBase: ReadonlyMap<string, QuotaGroupId>;
}

/**
 * Derives all runtime model views from a single declarative registry.
 * Pure function so tests can verify retirement toggling without mutating globals.
 */
export function buildModelRegistryViews(
  managedModels: Readonly<Record<string, ManagedModelEntry>>,
  discoveredModels: readonly DiscoveredOnlyModelEntry[],
  permanentlyRetiredBases: ReadonlySet<string> = RETIRED_MODEL_BASES,
): ModelRegistryViews {
  const retiredBases = new Set<string>(permanentlyRetiredBases);
  for (const [id, entry] of Object.entries(managedModels)) {
    if (entry.sunset?.retired) {
      retiredBases.add(normalizeModelBase(id));
    }
  }
  for (const entry of discoveredModels) {
    if (entry.sunset?.retired) {
      retiredBases.add(normalizeModelBase(entry.id));
    }
  }

  const definitions: OpencodeModelDefinitions = {};
  const v2FallbackIds: string[] = [];
  const proTierBases = new Set<string>();
  const tierSuffixFamilies: Array<readonly [string, readonly ModelThinkingLevel[]]> = [];
  const advertisedTierSuffixIds = new Set<string>();
  const aliases: Record<string, string> = {};
  const nonThinkingClaudeFallbackIds = new Set<string>();
  const quotaGroupsByBase = new Map<string, QuotaGroupId>();

  for (const [id, entry] of Object.entries(managedModels)) {
    const base = normalizeModelBase(id);
    if (entry.quotaGroup) {
      quotaGroupsByBase.set(base, entry.quotaGroup);
    }
    if (entry.sunset?.retired || retiredBases.has(base)) {
      continue;
    }

    definitions[id] = entry.definition;

    if (entry.v2Fallback) {
      v2FallbackIds.push(id);
    }

    if (entry.definition.proTier === true) {
      proTierBases.add(base);
    }

    if (entry.perTierBackendIds && entry.definition.variants) {
      const bareBase = id.replace(/^antigravity-/i, "").toLowerCase();
      const tiers = Object.keys(entry.definition.variants) as ModelThinkingLevel[];
      tierSuffixFamilies.push([bareBase, tiers]);
      for (const tier of tiers) {
        advertisedTierSuffixIds.add(`${bareBase}-${tier}`);
      }
    }

    if (entry.nonThinkingFallback) {
      nonThinkingClaudeFallbackIds.add(id.replace(/^antigravity-/i, "").toLowerCase());
    }

    if (entry.aliases) {
      Object.assign(aliases, entry.aliases);
    }
  }

  for (const entry of discoveredModels) {
    const base = normalizeModelBase(entry.id);
    if (entry.quotaGroup) {
      quotaGroupsByBase.set(base, entry.quotaGroup);
    }
    if (entry.sunset?.retired || retiredBases.has(base)) {
      continue;
    }
    if (entry.advertisedTierSuffix) {
      advertisedTierSuffixIds.add(entry.id.toLowerCase());
    }
  }

  return {
    definitions,
    v2FallbackIds,
    proTierBases,
    retiredBases,
    tierSuffixFamilies,
    advertisedTierSuffixIds: [...advertisedTierSuffixIds],
    aliases,
    nonThinkingClaudeFallbackIds,
    quotaGroupsByBase,
  };
}

const REGISTRY = buildModelRegistryViews(
  { ...ACTIVE_MANAGED_MODELS, ...SUNSET_MANAGED_MODELS },
  SUNSET_DISCOVERED_MODELS,
  RETIRED_MODEL_BASES,
);

export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = REGISTRY.definitions;
export const V2_FALLBACK_MODEL_IDS: readonly string[] = REGISTRY.v2FallbackIds;
export const PRO_TIER_MODEL_BASES: ReadonlySet<string> = REGISTRY.proTierBases;
export const RETIRED_MODEL_IDS: ReadonlySet<string> = REGISTRY.retiredBases;
export const SEEDED_TIER_SUFFIX_FAMILIES: ReadonlyArray<readonly [string, readonly ModelThinkingLevel[]]> =
  REGISTRY.tierSuffixFamilies;
export const SEEDED_ADVERTISED_TIER_SUFFIX_IDS: readonly string[] = REGISTRY.advertisedTierSuffixIds;
export const SEEDED_MODEL_ALIASES: Readonly<Record<string, string>> = REGISTRY.aliases;
export const NON_THINKING_CLAUDE_FALLBACK_IDS: ReadonlySet<string> = REGISTRY.nonThinkingClaudeFallbackIds;
export const QUOTA_GROUPS_BY_BASE: ReadonlyMap<string, QuotaGroupId> = REGISTRY.quotaGroupsByBase;

/**
 * Resolves the quota bucket for a model ID (and optional display name).
 * Explicit `quotaGroup` overrides in the registry take precedence over
 * `QUOTA_BUCKET_REGISTRY` fallback matchers so re-bucketing a model is a
 * single-field edit in `models.ts`.
 */
export function resolveQuotaGroupForModel(
  modelId: string,
  displayName?: string,
  overrides: ReadonlyMap<string, QuotaGroupId> = QUOTA_GROUPS_BY_BASE,
): QuotaGroupId | null {
  const override = overrides.get(normalizeModelBase(modelId));
  if (override) {
    return override;
  }
  const combined = `${modelId} ${displayName ?? ""}`;
  for (const bucket of QUOTA_BUCKET_REGISTRY) {
    if (bucket.defaultModelMatchers.some(pattern => pattern.test(combined))) {
      return bucket.id;
    }
  }
  return null;
}

/**
 * Resolves the quota bucket for a `retrieveUserQuotaSummary` group displayName.
 */
export function resolveQuotaGroupForSummary(displayName: string): QuotaGroupId | undefined {
  for (const bucket of QUOTA_BUCKET_REGISTRY) {
    if (bucket.summaryDisplayMatchers.some(pattern => pattern.test(displayName))) {
      return bucket.id;
    }
  }
  return undefined;
}

/**
 * Resolves the AccountManager routing family ("claude" | "gemini") for a model
 * using the declarative bucket registry, defaulting to "gemini" when unknown.
 */
export function resolveModelFamilyForRouting(
  modelId: string,
  overrides: ReadonlyMap<string, QuotaGroupId> = QUOTA_GROUPS_BY_BASE,
): "claude" | "gemini" {
  const group = resolveQuotaGroupForModel(modelId, undefined, overrides);
  if (!group) {
    return "gemini";
  }
  return QUOTA_BUCKET_BY_ID.get(group)?.modelFamily ?? "gemini";
}

/**
 * True when `modelId` belongs to a Pro-tier Antigravity model family.
 */
export function isProTierModelId(
  modelId: string,
  proTierBases: ReadonlySet<string> = PRO_TIER_MODEL_BASES,
): boolean {
  return proTierBases.has(normalizeModelBase(modelId));
}

/**
 * True when `modelId` matches a model marked retired in the registry or listed
 * in `RETIRED_MODEL_BASES`.
 */
export function isRetiredModelId(
  modelId: string,
  retiredBases: ReadonlySet<string> = RETIRED_MODEL_IDS,
): boolean {
  return retiredBases.has(normalizeModelBase(modelId));
}
