import { describe, expect, it } from "vitest";

import {
  ACTIVE_MANAGED_MODELS,
  FREE_TIER_MODEL_BASES,
  OPENCODE_MODEL_DEFINITIONS,
  PRO_TIER_MODEL_BASES,
  SUNSET_DISCOVERED_MODELS,
  SUNSET_MANAGED_MODELS,
  buildModelRegistryViews,
  isFreeTierModelId,
  isProTierModelId,
  isRetiredModelId,
  resolveModelFamilyForRouting,
  resolveQuotaGroupForModel,
  resolveQuotaGroupForSummary,
} from "./models";

const getModel = (name: string) => {
  const model = OPENCODE_MODEL_DEFINITIONS[name];
  if (!model) {
    throw new Error(`Missing model definition for ${name}`);
  }
  return model;
};

describe("OPENCODE_MODEL_DEFINITIONS", () => {
  it("includes the full set of configured models", () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort();

    expect(modelNames).toEqual([
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-claude-opus-5-5",
      "antigravity-claude-opus-5-5-thinking",
      "antigravity-claude-sonnet-4-6",
      "antigravity-claude-sonnet-5-5",
      "antigravity-gemini-3-flash",
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-4-argon",
      "antigravity-gemini-4-carbon",
      "antigravity-gemini-4-hydrogen",
      "antigravity-gemini-4-neon",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ]);
  });

  it("defines Gemini 3 variants for Antigravity models", () => {
    expect(getModel("antigravity-gemini-3-pro").variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });

    expect(getModel("antigravity-gemini-3.1-pro").variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });

    expect(getModel("antigravity-gemini-3-flash").variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
  });

  it("defines the Gemini 4 Carbon tier set (low, medium, high)", () => {
    expect(getModel("antigravity-gemini-4-carbon").variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(getModel("antigravity-gemini-4-carbon").proTier).toBe(true);
  });

  it("defines the full Gemini 4 Hydrogen tier set, including xhigh", () => {
    expect(getModel("antigravity-gemini-4-hydrogen").variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
      xhigh: { thinkingLevel: "xhigh" },
    });
  });

  it("defines the full Gemini 4 Neon tier set, including xhigh", () => {
    expect(getModel("antigravity-gemini-4-neon").variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
      xhigh: { thinkingLevel: "xhigh" },
    });
  });

  it("defines thinking budget variants for Claude thinking models", () => {
    expect(getModel("antigravity-claude-opus-4-6-thinking").variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    });
  });

  it("defines thinking level variants for Claude 5.5 models", () => {
    expect(getModel("antigravity-claude-sonnet-5-5").variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });

    expect(getModel("antigravity-claude-opus-5-5").variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
  });

  it("removes retired sunset models from every derived registry view", () => {
    const retiredSunset = Object.fromEntries(
      Object.entries(SUNSET_MANAGED_MODELS).map(([id, entry]) => [
        id,
        entry.sunset ? { ...entry, sunset: { ...entry.sunset, retired: true } } : entry,
      ]),
    );
    const retiredDiscovered = SUNSET_DISCOVERED_MODELS.map((entry) =>
      entry.sunset ? { ...entry, sunset: { ...entry.sunset, retired: true } } : entry,
    );

    const views = buildModelRegistryViews(
      { ...ACTIVE_MANAGED_MODELS, ...retiredSunset },
      retiredDiscovered,
    );

    expect(views.definitions["antigravity-gemini-4-argon"]).toBeUndefined();
    expect(views.definitions["antigravity-gemini-3.8-flash"]).toBeUndefined();
    expect(views.definitions["antigravity-claude-sonnet-4-6"]).toBeUndefined();
    expect(views.definitions["antigravity-claude-opus-4-6-thinking"]).toBeUndefined();
    expect(views.definitions["antigravity-gemini-4-carbon"]).toBeDefined();
    expect(views.v2FallbackIds).not.toContain("antigravity-gemini-4-argon");
    expect(views.v2FallbackIds).toContain("antigravity-gemini-4-carbon");
    expect(views.proTierBases.has("gemini-4-argon")).toBe(false);
    expect(views.proTierBases.has("gemini-4-carbon")).toBe(true);
    expect(views.advertisedTierSuffixIds).not.toContain("gpt-oss-120b-medium");
    expect(views.advertisedTierSuffixIds).not.toContain("gemini-3.8-flash-high");
    expect(views.advertisedTierSuffixIds).toContain("gemini-4-carbon-high");
    expect(views.tierSuffixFamilies.some(([base]) => base === "gemini-4-argon")).toBe(false);
    expect(views.tierSuffixFamilies.some(([base]) => base === "gemini-4-carbon")).toBe(true);
    expect(views.aliases["gemini-claude-sonnet-4-6"]).toBeUndefined();
    expect(views.nonThinkingClaudeFallbackIds.has("claude-sonnet-4-6")).toBe(false);
    expect(isRetiredModelId("antigravity-gemini-4-argon-high", views.retiredBases)).toBe(true);
    expect(isRetiredModelId("gpt-oss-120b-medium", views.retiredBases)).toBe(true);
    expect(isRetiredModelId("gemini-4-carbon-high", views.retiredBases)).toBe(false);
  });

  it("supports declarative per-model quota bucket overrides and summary display matching", () => {
    expect(resolveQuotaGroupForModel("gpt-oss-120b-medium")).toBe("claude");
    expect(resolveQuotaGroupForModel("antigravity-gemini-4-carbon-high")).toBe("gemini");
    expect(resolveQuotaGroupForModel("claude-sonnet-5-5-high")).toBe("claude");
    expect(resolveQuotaGroupForModel("unknown-internal-probe")).toBeNull();

    expect(resolveQuotaGroupForSummary("Gemini Models")).toBe("gemini");
    expect(resolveQuotaGroupForSummary("Claude and GPT models")).toBe("claude");
    expect(resolveQuotaGroupForSummary("Other")).toBeUndefined();

    // Moving a model between buckets only requires updating its registry `quotaGroup`.
    const customViews = buildModelRegistryViews(
      {
        ...ACTIVE_MANAGED_MODELS,
        "antigravity-gemini-4-neon": {
          ...ACTIVE_MANAGED_MODELS["antigravity-gemini-4-neon"]!,
          quotaGroup: "claude",
        },
      },
      SUNSET_DISCOVERED_MODELS,
    );
    expect(resolveQuotaGroupForModel("gemini-4-neon-high", undefined, customViews.quotaGroupsByBase)).toBe("claude");
    expect(resolveModelFamilyForRouting("antigravity-gemini-4-neon", customViews.quotaGroupsByBase)).toBe("claude");
  });

  it("marks Hydrogen as free-tier and keeps Carbon/Neon/Argon as pro-tier", () => {
    expect(FREE_TIER_MODEL_BASES.has("gemini-4-hydrogen")).toBe(true);
    expect(isFreeTierModelId("antigravity-gemini-4-hydrogen")).toBe(true);
    expect(isFreeTierModelId("gemini-4-hydrogen-high")).toBe(true);
    expect(isFreeTierModelId("gemini-4-carbon-high")).toBe(false);

    expect(PRO_TIER_MODEL_BASES.has("gemini-4-hydrogen")).toBe(false);
    expect(isProTierModelId("gemini-4-hydrogen-high")).toBe(false);
    expect(isProTierModelId("gemini-4-carbon-high")).toBe(true);
    expect(isRetiredModelId("gemini-3.8-flash")).toBe(true);
    expect(isRetiredModelId("gemini-3.8-flash-high")).toBe(true);
  });
});
