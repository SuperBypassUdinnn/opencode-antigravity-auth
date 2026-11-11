import { OPENCODE_MODEL_DEFINITIONS, type ModelModalities, type ModelThinkingLevel, type OpencodeModelDefinition } from "./models.ts"
import type { AvailableModel } from "../quota.ts"
import { registerAdvertisedModelIds, registerCatalogThinkingModelIds, registerTierSuffixModelBases } from "../transform/model-resolver.ts"
import { z } from "zod"

export const ModelCatalogCacheSchema = z.object({
  version: z.literal(4),
  identity: z.string(), updatedAt: z.number(),
  accounts: z.record(z.string(), z.array(z.string())),
  models: z.record(z.string(), z.object({
    displayName: z.string().optional(), maxTokens: z.number().positive().optional(), maxOutputTokens: z.number().positive().optional(),
    supportsImages: z.boolean().optional(), supportsThinking: z.boolean().optional(), disabled: z.boolean().optional(), selectable: z.boolean().optional(),
  })),
})

// Used before login or when discovery is unavailable. Once connected, Google's
// catalog replaces this list, including model IDs, names and token limits.
const fallbackModels: Record<string, OpencodeModelDefinition> = Object.fromEntries(
  ["antigravity-gemini-3-flash", "antigravity-gemini-3.8-flash", "antigravity-claude-sonnet-4-6", "antigravity-claude-opus-4-6-thinking", "antigravity-gemini-4-argon", "antigravity-claude-sonnet-5-5", "antigravity-claude-opus-5-5-thinking"]
    .flatMap(id => OPENCODE_MODEL_DEFINITIONS[id] ? [[id, OPENCODE_MODEL_DEFINITIONS[id]]] : []),
)

/** Model bases that must wait for the per-account discovery catalog before they
 * can be used. Before discovery the account pool is unknown, so common fallback
 * models may use any account while pro-tier models wait for the catalog, and a
 * free account never receives them. */
export const PRE_DISCOVERY_GATED_MODEL_BASES: ReadonlySet<string> = new Set(["gemini-4-argon", "claude-sonnet-5-5", "claude-opus-5-5"])

/**
 * Strips a leading `antigravity-` prefix (case-insensitive), a trailing
 * `-(minimal|low|medium|high)` tier suffix, and an optional `-thinking`
 * decoration, lowercases, then checks membership in
 * `PRE_DISCOVERY_GATED_MODEL_BASES`. The `-thinking` strip is needed because
 * Google's backend ids for thinking models mix both shapes
 * (claude-opus-5-5-high vs claude-opus-4-6-thinking-high). This gate only
 * applies before the per-account discovery catalog is loaded.
 */
export function isPreDiscoveryGatedModel(catalogKey: string): boolean {
  const key = catalogKey
    .replace(/^antigravity-/i, "")
    .replace(/-(minimal|low|medium|high)$/i, "")
    .replace(/-thinking$/i, "")
  return PRE_DISCOVERY_GATED_MODEL_BASES.has(key.toLowerCase())
}

function definition(model: OpencodeModelDefinition) {
  return {
    name: model.name,
    package: "aisdk:@ai-sdk/google",
    limit: { ...model.limit },
    capabilities: { tools: true, ...model.modalities },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    variants: Object.entries(model.variants ?? {}).map(([id, settings]) => ({
      id,
      settings: settings.thinkingLevel
        ? // includeThoughts must ride along with the level: opencode forwards the
          // settings verbatim as providerOptions.google.thinkingConfig, and a
          // thinkingLevel-only config would otherwise suppress thought summaries.
          { thinkingConfig: { includeThoughts: true, thinkingLevel: settings.thinkingLevel } }
        : { ...settings },
    })),
  }
}

export const OPENCODE_V2_MODEL_DEFINITIONS = Object.fromEntries(
  Object.entries(fallbackModels).map(([id, model]) => [id, definition(model)]),
)
export type V2ModelDefinitions = typeof OPENCODE_V2_MODEL_DEFINITIONS

const TIER_ORDER = ["minimal", "low", "medium", "high"] as const
type CatalogTier = (typeof TIER_ORDER)[number]
const CATALOG_TIER_SUFFIX = /^(.*)-(minimal|low|medium|high)$/
const TIER_LABEL = /\s*\((?:minimal|low|medium|high)\)\s*$/i

/** Excludes completion/internal, image-generation, tier routers and disabled entries. */
function isChatModel(id: string, model: AvailableModel): boolean {
  return /^(gemini-|claude-|gpt-oss-)/.test(id)
    && !/image|imagen|-(disabled|tiered)$/.test(id)
    && !model.disabled
    && model.selectable !== false
}

function tierOf(id: string): { base: string; tier: CatalogTier } | undefined {
  const match = id.match(CATALOG_TIER_SUFFIX)
  const base = match?.[1]
  const tier = match?.[2] as CatalogTier | undefined
  return base && tier ? { base, tier } : undefined
}

/**
 * Families the catalog advertises only as per-tier IDs (e.g. gemini-3.8-flash-low,
 * -medium, -high) with no bare base ID. Two or more published tiers collapse into
 * one model carrying a variant per tier: the backend rejects the bare base ID, so
 * the request path rewrites it from the selected variant.
 */
function collapsibleFamilies(models: Record<string, AvailableModel>): Map<string, CatalogTier[]> {
  const tiers = new Map<string, Set<CatalogTier>>()
  for (const [id, model] of Object.entries(models)) {
    const parsed = tierOf(id)
    // A published base ID means the catalog has a real model by that name.
    if (!parsed || !isChatModel(id, model) || models[parsed.base]) continue
    let found = tiers.get(parsed.base)
    if (!found) {
      found = new Set<CatalogTier>()
      tiers.set(parsed.base, found)
    }
    found.add(parsed.tier)
  }
  return new Map([...tiers]
    .filter(([, found]) => found.size > 1)
    .map(([base, found]) => [base, TIER_ORDER.filter(tier => found.has(tier))]))
}

/** Maps every published catalog ID to the model ID this plugin exposes for it. */
export function modelKeyMap(models: Record<string, AvailableModel>): Map<string, string> {
  const families = collapsibleFamilies(models)
  const keys = new Map<string, string>()
  for (const [id, model] of Object.entries(models)) {
    if (!isChatModel(id, model)) continue
    const parsed = tierOf(id)
    keys.set(id, `antigravity-${parsed && families.has(parsed.base) ? parsed.base : id}`)
  }
  return keys
}

function limitsOf(model: AvailableModel | undefined, known: OpencodeModelDefinition | undefined) {
  return {
    context: model?.maxTokens ?? known?.limit.context ?? 200000,
    output: model?.maxOutputTokens ?? known?.limit.output ?? 64000,
  }
}

function modalitiesOf(model: AvailableModel | undefined): ModelModalities {
  return { input: model?.supportsImages === false ? ["text"] : ["text", "image", "pdf"], output: ["text"] }
}

export function buildAccountModelDefinitions(models: Record<string, AvailableModel>): V2ModelDefinitions {
  const definitions: V2ModelDefinitions = {}
  const families = collapsibleFamilies(models)
  const collapsed = new Set([...families].flatMap(([base, tiers]) => tiers.map(tier => `${base}-${tier}`)))

  for (const [id, model] of Object.entries(models)) {
    if (!isChatModel(id, model) || collapsed.has(id)) continue
    const key = `antigravity-${id}`
    const known = OPENCODE_MODEL_DEFINITIONS[key]
    definitions[key] = definition({
      name: `${model.displayName ?? id} (Antigravity)`,
      limit: limitsOf(model, known),
      modalities: modalitiesOf(model),
      variants: known?.variants,
    })
  }

  for (const [base, tiers] of families) {
    const tierModels = tiers.map(tier => models[`${base}-${tier}`])
    const representative = tierModels[tiers.indexOf("high")] ?? tierModels[0]
    if (!representative) continue
    const key = `antigravity-${base}`
    const known = OPENCODE_MODEL_DEFINITIONS[key]
    const name = representative.displayName?.replace(TIER_LABEL, "")
      || known?.name.replace(/\s*\(Antigravity\)$/i, "")
      || base
    definitions[key] = definition({
      name: `${name} (Antigravity)`,
      limit: limitsOf(representative, known),
      modalities: modalitiesOf(representative),
      variants: Object.fromEntries(tiers.map((tier): [string, { thinkingLevel: ModelThinkingLevel }] => [tier, { thinkingLevel: tier }])),
    })
  }

  registerAdvertisedModelIds(Object.keys(models))
  // Google's catalog marks thinking-capable models via the displayName, e.g.
  // "Claude Sonnet 4.6 (Thinking)". Register them so request transforms can
  // enable thinking for claude ids that carry no -thinking suffix.
  registerCatalogThinkingModelIds(
    Object.entries(models)
      .filter(([, model]) => model.displayName?.toLowerCase().includes("(thinking)"))
      .map(([id]) => id),
  )
  registerTierSuffixModelBases(families)
  return definitions
}
