/**
 * Model Resolution with Thinking Tier Support
 * 
 * Resolves model names with tier suffixes (e.g., gemini-3-pro-high, claude-opus-4-6-thinking-low)
 * to their actual API model names and corresponding thinking configurations.
 */

import type { ResolvedModel, ThinkingTier, GoogleSearchConfig } from "./types";

export interface ModelResolverOptions {
  cli_first?: boolean;
}

/**
 * Thinking tier budgets by model family.
 * Claude and Gemini 2.5 Pro use numeric budgets.
 */
export const THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-pro": { low: 8192, medium: 16384, high: 32768 },
  "gemini-2.5-flash": { low: 6144, medium: 12288, high: 24576 },
  default: { low: 4096, medium: 8192, high: 16384 },
} as const;

/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: minimal, low, medium, high
 * Pro supports: low, high (no minimal/medium)
 */
export const GEMINI_3_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

/**
 * Model aliases - maps user-friendly names to API model names.
 * 
 * Format:
 * - Gemini 3 Pro variants: gemini-3-pro-{low,medium,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Gemini 3 variants - for Gemini CLI only (tier stripped, thinkingLevel used)
  // For Antigravity, these are bypassed and full model name is kept
  "gemini-3-pro-low": "gemini-3-pro",
  "gemini-3-pro-high": "gemini-3-pro",
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-3.1-pro-high": "gemini-3.1-pro",
  "gemini-3-flash-low": "gemini-3-flash",
  "gemini-3-flash-medium": "gemini-3-flash",
  "gemini-3-flash-high": "gemini-3-flash",

  // Claude proxy names (gemini- prefix for compatibility)
  "gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
  "gemini-claude-sonnet-4-6": "claude-sonnet-4-6",

  // Image generation models - only gemini-3-pro-image is available via Antigravity API
  // Note: gemini-2.5-flash-image (Nano Banana) is NOT supported by Antigravity - only Google AI API
  // Reference: Antigravity-Manager/src-tauri/src/proxy/common/model_mapping.rs
};

/**
 * Model IDs that Antigravity fetchAvailableModels advertises verbatim with a
 * tier-like suffix. The suffix is part of the real model ID, so it must reach the
 * API unchanged instead of being stripped as a legacy thinking-tier alias.
 */
const advertisedModelIds = new Set([
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-high",
  "gemini-4-argon-high",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gpt-oss-120b-medium",
]);
export const ADVERTISED_TIER_SUFFIX_MODEL_IDS: ReadonlySet<string> = advertisedModelIds;

/** Preserve backend IDs discovered from Google's account-specific catalog. */
export function registerAdvertisedModelIds(ids: Iterable<string>): void {
  for (const id of ids) advertisedModelIds.add(id.toLowerCase());
}

/** Backend IDs whose catalog displayName marks them as "(Thinking)". */
const catalogThinkingModelIds = new Set<string>();

/** Preserve thinking-capable IDs discovered from Google's account-specific catalog. */
export function registerCatalogThinkingModelIds(ids: Iterable<string>): void {
  for (const id of ids) catalogThinkingModelIds.add(id.toLowerCase());
}

/** True when Google's catalog lists this model as "(Thinking)". Some thinking
 * models (e.g. Claude Sonnet 4.6) carry no "-thinking" id suffix, so the
 * catalog displayName is the only reliable marker. Accepts names with or
 * without the "antigravity-" quota prefix and strips a trailing thinking-tier
 * suffix the same way the signature cache key does, so tier-variant ids
 * (e.g. claude-opus-4-6-thinking-high) still match their catalog base. */
export function isCatalogThinkingModel(model: string): boolean {
  return catalogThinkingModelIds.has(
    model
      .replace(QUOTA_PREFIX_REGEX, "")
      .replace(/-(minimal|low|medium|high)$/i, "")
      .toLowerCase(),
  );
}

const TIER_REGEX = /-(minimal|low|medium|high)$/;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;
const GEMINI_3_PRO_REGEX = /^gemini-3(?:\.\d+)?-pro/i;
const GEMINI_3_FLASH_REGEX = /^gemini-3(?:\.\d+)?-flash/i;

// ANTIGRAVITY_ONLY_MODELS removed - all models now default to antigravity

/**
 * Image generation models - always route to Antigravity.
 * These models don't support thinking and require imageConfig.
 */
const IMAGE_GENERATION_MODELS = /image|imagen/i;

// Legacy LEGACY_ANTIGRAVITY_GEMINI3 regex removed - all Gemini models now default to antigravity

/**
 * Models that support thinking tier suffixes.
 * Only these models should have -low/-medium/-high stripped as thinking tiers.
 * GPT models like gpt-oss-120b-medium should NOT have -medium stripped.
 */
function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5") ||
    (lower.includes("claude") && lower.includes("thinking"))
  );
}

/**
 * Extracts thinking tier from model name suffix.
 * Only extracts tier for models that support thinking tiers.
 */
function extractThinkingTierFromModel(model: string): ThinkingTier | undefined {
  // Only extract tier for models that support thinking tiers
  if (!supportsThinkingTiers(model)) {
    return undefined;
  }
  const tierMatch = model.match(TIER_REGEX);
  return tierMatch?.[1] as ThinkingTier | undefined;
}

/**
 * Determines the budget family for a model.
 */
function getBudgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
  if (model.includes("claude")) {
    return "claude";
  }
  if (model.includes("gemini-2.5-pro")) {
    return "gemini-2.5-pro";
  }
  if (model.includes("gemini-2.5-flash")) {
    return "gemini-2.5-flash";
  }
  return "default";
}

/**
 * Checks if a model is a thinking-capable model.
 */
function isThinkingCapableModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("thinking") ||
    lower.includes("gemini-3") ||
    lower.includes("gemini-2.5")
  );
}

function isGemini3ProModel(model: string): boolean {
  return GEMINI_3_PRO_REGEX.test(model);
}

function isGemini3FlashModel(model: string): boolean {
  return GEMINI_3_FLASH_REGEX.test(model);
}

/**
 * True for advertised model IDs whose tier-like suffix must not be stripped.
 * Accepts names with or without the "antigravity-" quota prefix.
 */
export function isAdvertisedTierSuffixModel(model: string): boolean {
  return ADVERTISED_TIER_SUFFIX_MODEL_IDS.has(model.replace(QUOTA_PREFIX_REGEX, "").toLowerCase());
}

/**
 * Families whose backend IDs are per-tier only (e.g. gemini-3.8-flash-low,
 * -medium, -high) with no bare base ID, mapped to the tiers that family actually
 * publishes. The plugin publishes one model for such a family, so the selected
 * variant has to select the backend ID.
 *
 * gemini-3.8-flash is seeded because it is a known family before discovery runs;
 * discovered families register themselves so new ones work without a release.
 */
const tierSuffixModelFamilies = new Map<string, ReadonlySet<string>>([
  ["gemini-3.8-flash", new Set<ThinkingTier>(["low", "medium", "high"])],
]);

/** Tiers tried in order when the requested level is not published for a family. */
const TIER_FALLBACK_ORDER: readonly ThinkingTier[] = ["low", "medium", "high"];

export function registerTierSuffixModelBases(families: Iterable<readonly [string, Iterable<string>]>): void {
  for (const [family, tiers] of families) {
    const base = family.replace(QUOTA_PREFIX_REGEX, "").replace(TIER_REGEX, "").toLowerCase();
    tierSuffixModelFamilies.set(base, new Set(tiers));
  }
}

/**
 * Selects the backend ID for a per-tier-only family from a thinking level.
 *
 * The level already reflects the selected variant, so a family that has one
 * backend ID per tier must send that ID; the bare base is rejected with 404.
 * A level the family does not publish falls back to a published tier rather
 * than emitting an ID that does not exist. Models outside such a family, and
 * the Gemini CLI route (which appends "-preview" instead), are returned
 * unchanged.
 */
export function applyTierModelSuffix(model: string, level: string | undefined): string {
  const stripped = model.replace(TIER_REGEX, "");
  const published = tierSuffixModelFamilies.get(stripped.replace(QUOTA_PREFIX_REGEX, "").toLowerCase());
  if (!published) return model;
  const requested = (level ?? "").toLowerCase();
  if (published.has(requested)) return `${stripped}-${requested}`;
  const fallback = TIER_FALLBACK_ORDER.find((tier) => published.has(tier));
  return fallback ? `${stripped}-${fallback}` : model;
}

/**
 * Resolves a model name with optional tier suffix and quota prefix to its actual API model name
 * and corresponding thinking configuration.
 *
 * Quota routing:
 * - Default to Antigravity quota unless cli_first is enabled for Gemini models
 * - Fallback to Gemini CLI happens at account rotation level when Antigravity is exhausted
 * - "antigravity-" prefix marks explicit quota (no fallback allowed)
 * - Claude and image models always use Antigravity
 *
 * Examples:
 * - "gemini-2.5-flash" → { quotaPreference: "antigravity" }
 * - "gemini-3-pro-preview" → { quotaPreference: "antigravity" }
 * - "antigravity-gemini-3-pro-high" → { quotaPreference: "antigravity", explicitQuota: true }
 * - "claude-opus-4-6-thinking-medium" → { quotaPreference: "antigravity" }
 *
 * @param requestedModel - The model name from the request
 * @param options - Optional configuration including cli_first preference
 * @returns Resolved model with thinking configuration
 */
export function resolveModelWithTier(requestedModel: string, options: ModelResolverOptions = {}): ResolvedModel {
  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, "");

  const isAdvertisedTierId = isAdvertisedTierSuffixModel(modelWithoutQuota);

  const tier = extractThinkingTierFromModel(modelWithoutQuota);
  // Advertised IDs keep their suffix; it still selects the thinking level below.
  const baseName = tier && !isAdvertisedTierId ? modelWithoutQuota.replace(TIER_REGEX, "") : modelWithoutQuota;

  const isImageModel = IMAGE_GENERATION_MODELS.test(modelWithoutQuota);
  const isClaudeModel = modelWithoutQuota.toLowerCase().includes("claude");
  
  // All models default to Antigravity quota unless cli_first is enabled
  // Fallback to gemini-cli happens at the account rotation level when Antigravity is exhausted
  const preferGeminiCli = options.cli_first === true && !isAntigravity && !isImageModel && !isClaudeModel;
  const quotaPreference = preferGeminiCli ? "gemini-cli" as const : "antigravity" as const;
  const explicitQuota = isAntigravity || isImageModel;

  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith("gemini-3");
  const skipAlias = isAntigravity && isGemini3;

  // For Antigravity Gemini 3 Pro models without explicit tier, append default tier
  // Antigravity API: gemini-3-pro requires tier suffix (gemini-3-pro-low/high)
  //                  gemini-3-flash uses bare name + thinkingLevel param
  // Pro defaults to -low unless an explicit tier is provided
  const isGemini3Pro = isGemini3ProModel(modelWithoutQuota);
  const isGemini3Flash = isGemini3FlashModel(modelWithoutQuota);
  
  let antigravityModel = modelWithoutQuota;
  if (skipAlias && !isAdvertisedTierId) {
    if (isGemini3Pro && !tier && !isImageModel) {
      antigravityModel = `${modelWithoutQuota}-low`;
    } else if (isGemini3Flash && tier) {
      antigravityModel = baseName;
    }
  }

  const actualModel = skipAlias || isAdvertisedTierId
    ? antigravityModel
    : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName;

  const resolvedModel = actualModel;

  const isThinking = isThinkingCapableModel(resolvedModel);

  // Image generation models don't support thinking - return early without thinking config
  if (isImageModel) {
    return {
      actualModel: resolvedModel,
      isThinkingModel: false,
      isImageModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  // Check if this is a Gemini 3 model (works for both aliased and skipAlias paths)
  const isEffectiveGemini3 = resolvedModel.toLowerCase().includes("gemini-3");
  const isClaudeThinking = resolvedModel.toLowerCase().includes("claude") && resolvedModel.toLowerCase().includes("thinking");

  if (!tier) {
    // Gemini 3 models without explicit tier get a default thinkingLevel
    if (isEffectiveGemini3) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: "low",
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    // Claude thinking models without explicit tier get max budget (32768)
    // Per Anthropic docs, budget_tokens is required when enabling extended thinking
    if (isClaudeThinking) {
      return {
        actualModel: resolvedModel,
        thinkingBudget: THINKING_TIER_BUDGETS.claude.high,
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    return { actualModel: resolvedModel, isThinkingModel: isThinking, quotaPreference, explicitQuota };
  }

  // Gemini 3 models with tier always get thinkingLevel set
  if (isEffectiveGemini3) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  const budgetFamily = getBudgetFamily(resolvedModel);
  const budgets = THINKING_TIER_BUDGETS[budgetFamily];
  const thinkingBudget = budgets[tier];

  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
    quotaPreference,
    explicitQuota,
  };
}

/**
 * Gets the model family for routing decisions.
 */
export function getModelFamily(model: string): "claude" | "gemini-flash" | "gemini-pro" {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  if (lower.includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}

/**
 * Variant config from OpenCode's providerOptions.
 */
export interface VariantConfig {
  thinkingBudget?: number;
  googleSearch?: GoogleSearchConfig;
}

/**
 * Maps a thinking budget to Gemini 3 thinking level.
 * ≤8192 → low, ≤16384 → medium, >16384 → high
 */
function budgetToGemini3Level(budget: number): "low" | "medium" | "high" {
  if (budget <= 8192) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

/**
 * Resolves model name for a specific headerStyle (quota fallback support).
 * Transforms model names when switching between gemini-cli and antigravity quotas.
 * 
 * Issue #103: When quota fallback occurs, model names need to be transformed:
 * - gemini-3-flash-preview (gemini-cli) → gemini-3-flash (antigravity)
 * - gemini-3-pro-preview (gemini-cli) → gemini-3-pro-low (antigravity)
 * - gemini-3-flash (antigravity) → gemini-3-flash-preview (gemini-cli)
 */
export function resolveModelForHeaderStyle(
  requestedModel: string,
  headerStyle: "antigravity" | "gemini-cli"
): ResolvedModel {
  const lower = requestedModel.toLowerCase();
  const isGemini3 = lower.includes("gemini-3");
  
  if (!isGemini3) {
    return resolveModelWithTier(requestedModel);
  }

  if (headerStyle === "antigravity") {
    let transformedModel = requestedModel
      .replace(/-preview-customtools$/i, "")
      .replace(/-preview$/i, "")
      .replace(/^antigravity-/i, "");
    
    const isGemini3Pro = isGemini3ProModel(transformedModel);
    const hasTierSuffix = /-(low|medium|high)$/i.test(transformedModel);
    const isImageModel = IMAGE_GENERATION_MODELS.test(transformedModel);
    
    // Don't add tier suffix to image models - they don't support thinking
    if (isGemini3Pro && !hasTierSuffix && !isImageModel) {
      transformedModel = `${transformedModel}-low`;
    }
    
    const prefixedModel = `antigravity-${transformedModel}`;
    return resolveModelWithTier(prefixedModel);
  }
  
  if (headerStyle === "gemini-cli") {
    let transformedModel = requestedModel
      .replace(/^antigravity-/i, "")
      .replace(/-(low|medium|high)$/i, "");

    const hasPreviewSuffix = /-preview($|-)/i.test(transformedModel);
    if (!hasPreviewSuffix) {
      transformedModel = `${transformedModel}-preview`;
    }
    
    return {
      ...resolveModelWithTier(transformedModel),
      quotaPreference: "gemini-cli",
    };
  }

  return resolveModelWithTier(requestedModel);
}

/**
 * Resolves model with variant config from providerOptions.
 * Variant config takes priority over tier suffix in model name.
 */
export function resolveModelWithVariant(
  requestedModel: string,
  variantConfig?: VariantConfig
): ResolvedModel {
  const base = resolveModelWithTier(requestedModel);

  if (!variantConfig) {
    return base;
  }

  // Apply Google Search config if present
  if (variantConfig.googleSearch) {
    base.googleSearch = variantConfig.googleSearch;
    base.configSource = "variant";
  }

  if (!variantConfig.thinkingBudget) {
    return base;
  }

  const budget = variantConfig.thinkingBudget;
  const isGemini3 = base.actualModel.toLowerCase().includes("gemini-3");

  if (isGemini3) {
    const level = budgetToGemini3Level(budget);
    const isAntigravityGemini3Pro = base.quotaPreference === "antigravity" &&
      isGemini3ProModel(base.actualModel) &&
      !isAdvertisedTierSuffixModel(base.actualModel);

    let actualModel = base.actualModel;
    if (isAntigravityGemini3Pro) {
      const baseModel = base.actualModel.replace(/-(low|medium|high)$/, "");
      actualModel = `${baseModel}-${level}`;
    }

    return {
      ...base,
      actualModel,
      thinkingLevel: level,
      thinkingBudget: undefined,
      configSource: "variant",
    };
  }

  return {
    ...base,
    thinkingBudget: budget,
    configSource: "variant",
  };
}
