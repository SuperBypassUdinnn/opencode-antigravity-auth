import { describe, it, expect } from "vitest";
import {
  ADVERTISED_TIER_SUFFIX_MODEL_IDS,
  isCatalogThinkingModel,
  registerCatalogThinkingModelIds,
  applyTierModelSuffix,
  publishedTierFor,
  budgetToGemini3Level,
  isAdvertisedTierSuffixModel,
  registerTierSuffixModelBases,
  resolveModelWithTier,
  resolveModelWithVariant,
  resolveModelForHeaderStyle,
  getModelFamily,
} from "./model-resolver";
import { XHIGH_TIER_BUDGET } from "../config/models";

describe("resolveModelWithTier", () => {
  describe("Gemini 3 flash models (Issue #109)", () => {
    it("antigravity-gemini-3-flash gets default thinkingLevel 'low'", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-flash");
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-3-flash gets default thinkingLevel 'low'", () => {
      const result = resolveModelWithTier("gemini-3-flash");
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-3-flash-preview gets default thinkingLevel 'low' with antigravity quota", () => {
      const result = resolveModelWithTier("gemini-3-flash-preview");
      expect(result.actualModel).toBe("gemini-3-flash-preview");
      expect(result.thinkingLevel).toBe("low");
      // All Gemini models now default to antigravity
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("Gemini 3 preview models (Issue #115)", () => {
    it("gemini-3-pro-preview gets default thinkingLevel 'low' with antigravity quota", () => {
      const result = resolveModelWithTier("gemini-3-pro-preview");
      expect(result.actualModel).toBe("gemini-3-pro-preview");
      expect(result.thinkingLevel).toBe("low");
      // All Gemini models now default to antigravity
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-3.1-pro-preview gets default thinkingLevel 'low' with antigravity quota", () => {
      const result = resolveModelWithTier("gemini-3.1-pro-preview");
      expect(result.actualModel).toBe("gemini-3.1-pro-preview");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("All Gemini models default to antigravity quota", () => {
    it("gemini-2.5-flash defaults to antigravity", () => {
      const result = resolveModelWithTier("gemini-2.5-flash");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-2.5-pro defaults to antigravity", () => {
      const result = resolveModelWithTier("gemini-2.5-pro");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("gemini-2.0-flash defaults to antigravity", () => {
      const result = resolveModelWithTier("gemini-2.0-flash");
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("cli_first quota preference", () => {
    it("prefers gemini-cli when cli_first is true and no prefix is set", () => {
      const result = resolveModelWithTier("gemini-3-flash", { cli_first: true });
      expect(result.quotaPreference).toBe("gemini-cli");
      expect(result.explicitQuota).toBe(false);
    });

    it("keeps antigravity when antigravity prefix is explicit", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-flash", { cli_first: true });
      expect(result.quotaPreference).toBe("antigravity");
      expect(result.explicitQuota).toBe(true);
    });

    it("keeps antigravity for Claude models when cli_first is true", () => {
      const result = resolveModelWithTier("claude-opus-4-6-thinking", { cli_first: true });
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("keeps antigravity for image models when cli_first is true", () => {
      const result = resolveModelWithTier("gemini-3-pro-image", { cli_first: true });
      expect(result.quotaPreference).toBe("antigravity");
      expect(result.explicitQuota).toBe(true);
    });

    it("defaults to antigravity when cli_first is false", () => {
      const result = resolveModelWithTier("gemini-3-flash", { cli_first: false });
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("Antigravity Gemini 3 with tier suffix", () => {
    it("antigravity-gemini-3-pro-low gets thinkingLevel from tier", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-pro-low");
      expect(result.actualModel).toBe("gemini-3-pro-low");
      expect(result.thinkingLevel).toBe("low");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("antigravity-gemini-3-pro-high gets thinkingLevel from tier", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-pro-high");
      expect(result.actualModel).toBe("gemini-3-pro-high");
      expect(result.thinkingLevel).toBe("high");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("antigravity-gemini-3-flash-medium gets thinkingLevel from tier", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-flash-medium");
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.thinkingLevel).toBe("medium");
    });

    it("antigravity-gemini-3.1-pro gets default -low model", () => {
      const result = resolveModelWithTier("antigravity-gemini-3.1-pro");
      expect(result.actualModel).toBe("gemini-3.1-pro-low");
      expect(result.thinkingLevel).toBe("low");
    });
  });

  describe("Claude thinking models default budget", () => {
    it("antigravity-claude-opus-4-6-thinking gets default max budget (32768)", () => {
      const result = resolveModelWithTier("antigravity-claude-opus-4-6-thinking");
      expect(result.actualModel).toBe("claude-opus-4-6-thinking");
      expect(result.thinkingBudget).toBe(32768);
      expect(result.isThinkingModel).toBe(true);
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("Claude Sonnet 4.6 (non-thinking)", () => {
    it("claude-sonnet-4-6 resolves as non-thinking model", () => {
      const result = resolveModelWithTier("claude-sonnet-4-6");
      expect(result.actualModel).toBe("claude-sonnet-4-6");
      expect(result.isThinkingModel).toBe(false);
      expect(result.thinkingBudget).toBeUndefined();
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("antigravity-claude-sonnet-4-6 resolves as non-thinking model with explicit quota", () => {
      const result = resolveModelWithTier("antigravity-claude-sonnet-4-6");
      expect(result.actualModel).toBe("claude-sonnet-4-6");
      expect(result.isThinkingModel).toBe(false);
      expect(result.thinkingBudget).toBeUndefined();
      expect(result.quotaPreference).toBe("antigravity");
      expect(result.explicitQuota).toBe(true);
    });

    it("gemini-claude-sonnet-4-6 alias resolves to claude-sonnet-4-6", () => {
      const result = resolveModelWithTier("gemini-claude-sonnet-4-6");
      expect(result.actualModel).toBe("claude-sonnet-4-6");
      expect(result.isThinkingModel).toBe(false);
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("Image models", () => {
    it("marks antigravity-gemini-3-pro-image as explicit quota", () => {
      const result = resolveModelWithTier("antigravity-gemini-3-pro-image");
      expect(result.actualModel).toBe("gemini-3-pro-image");
      expect(result.isImageModel).toBe(true);
      expect(result.explicitQuota).toBe(true);
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("marks gemini-3-pro-image as explicit quota", () => {
      const result = resolveModelWithTier("gemini-3-pro-image");
      expect(result.actualModel).toBe("gemini-3-pro-image");
      expect(result.isImageModel).toBe(true);
      expect(result.explicitQuota).toBe(true);
      expect(result.quotaPreference).toBe("antigravity");
    });
  });
});

describe("resolveModelWithVariant", () => {
  describe("without variant config", () => {
    it("falls back to tier resolution for Claude thinking models", () => {
      const result = resolveModelWithVariant("claude-opus-4-6-thinking-low");
      expect(result.actualModel).toBe("claude-opus-4-6-thinking");
      expect(result.thinkingBudget).toBe(8192);
      expect(result.configSource).toBeUndefined();
    });

    it("falls back to tier resolution for Gemini 3 models", () => {
      const result = resolveModelWithVariant("gemini-3-pro-high");
      expect(result.actualModel).toBe("gemini-3-pro");
      expect(result.thinkingLevel).toBe("high");
      expect(result.configSource).toBeUndefined();
    });
  });

  describe("with variant config", () => {
    it("overrides tier budget for Claude models", () => {
      const result = resolveModelWithVariant("antigravity-claude-opus-4-6-thinking", {
        thinkingBudget: 24000,
      });
      expect(result.actualModel).toBe("claude-opus-4-6-thinking");
      expect(result.thinkingBudget).toBe(24000);
      expect(result.configSource).toBe("variant");
    });

    it("maps budget to thinkingLevel for Gemini 3 - low", () => {
      const result = resolveModelWithVariant("antigravity-gemini-3-pro", {
        thinkingBudget: 8000,
      });
      expect(result.actualModel).toBe("gemini-3-pro-low");
      expect(result.thinkingLevel).toBe("low");
      expect(result.thinkingBudget).toBeUndefined();
      expect(result.configSource).toBe("variant");
    });

    it("maps budget to thinkingLevel for Gemini 3 Flash - medium (no tier suffix)", () => {
      const result = resolveModelWithVariant("antigravity-gemini-3-flash", {
        thinkingBudget: 12000,
      });
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.thinkingLevel).toBe("medium");
      expect(result.configSource).toBe("variant");
    });

    it("maps budget to thinkingLevel for Gemini 3 - high", () => {
      const result = resolveModelWithVariant("antigravity-gemini-3-pro", {
        thinkingBudget: 32000,
      });
      expect(result.thinkingLevel).toBe("high");
      expect(result.configSource).toBe("variant");
    });

    it("uses budget directly for non-Gemini 3 models", () => {
      const result = resolveModelWithVariant("gemini-2.5-pro", {
        thinkingBudget: 20000,
      });
      expect(result.thinkingBudget).toBe(20000);
      expect(result.thinkingLevel).toBeUndefined();
      expect(result.configSource).toBe("variant");
    });

    it("maps the xhigh sentinel only for families that publish the tier", () => {
      const hydrogen = resolveModelWithVariant("antigravity-gemini-4-hydrogen", {
        thinkingBudget: XHIGH_TIER_BUDGET,
      });
      expect(hydrogen.actualModel).toBe("gemini-4-hydrogen");
      expect(hydrogen.thinkingLevel).toBe("xhigh");

      const neon = resolveModelWithVariant("antigravity-gemini-4-neon", {
        thinkingBudget: XHIGH_TIER_BUDGET,
      });
      expect(neon.actualModel).toBe("gemini-4-neon");
      expect(neon.thinkingLevel).toBe("xhigh");

      const flash = resolveModelWithVariant("antigravity-gemini-3.8-flash", {
        thinkingBudget: XHIGH_TIER_BUDGET,
      });
      expect(flash.thinkingLevel).toBe("low");
    });
  });

  describe("backward compatibility", () => {
    it("tier-suffixed models work without variant config", () => {
      const lowResult = resolveModelWithVariant("claude-opus-4-6-thinking-low");
      expect(lowResult.thinkingBudget).toBe(8192);

      const medResult = resolveModelWithVariant("claude-opus-4-6-thinking-medium");
      expect(medResult.thinkingBudget).toBe(16384);

      const highResult = resolveModelWithVariant("claude-opus-4-6-thinking-high");
      expect(highResult.thinkingBudget).toBe(32768);
    });

    it("variant config overrides tier suffix", () => {
      const result = resolveModelWithVariant("claude-opus-4-6-thinking-low", {
        thinkingBudget: 50000,
      });
      expect(result.thinkingBudget).toBe(50000);
      expect(result.configSource).toBe("variant");
    });
  });
});

describe("Issue #103: resolveModelForHeaderStyle", () => {
  describe("quota fallback from gemini-cli to antigravity", () => {
    it("transforms gemini-3-flash-preview to gemini-3-flash for antigravity", () => {
      const result = resolveModelForHeaderStyle("gemini-3-flash-preview", "antigravity");
      expect(result.actualModel).toBe("gemini-3-flash");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("transforms gemini-3-pro-preview to gemini-3-pro-low for antigravity", () => {
      const result = resolveModelForHeaderStyle("gemini-3-pro-preview", "antigravity");
      expect(result.actualModel).toBe("gemini-3-pro-low");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("transforms gemini-3.1-pro-preview to gemini-3.1-pro-low for antigravity", () => {
      const result = resolveModelForHeaderStyle("gemini-3.1-pro-preview", "antigravity");
      expect(result.actualModel).toBe("gemini-3.1-pro-low");
      expect(result.quotaPreference).toBe("antigravity");
    });

    it("transforms gemini-3.1-pro-preview-customtools to gemini-3.1-pro-low for antigravity", () => {
      const result = resolveModelForHeaderStyle("gemini-3.1-pro-preview-customtools", "antigravity");
      expect(result.actualModel).toBe("gemini-3.1-pro-low");
      expect(result.quotaPreference).toBe("antigravity");
    });
  });

  describe("quota fallback from antigravity to gemini-cli", () => {
    it("transforms gemini-3-flash to gemini-3-flash-preview for gemini-cli", () => {
      const result = resolveModelForHeaderStyle("gemini-3-flash", "gemini-cli");
      expect(result.actualModel).toBe("gemini-3-flash-preview");
      expect(result.quotaPreference).toBe("gemini-cli");
    });

    it("transforms gemini-3-pro-low to gemini-3-pro-preview for gemini-cli", () => {
      const result = resolveModelForHeaderStyle("gemini-3-pro-low", "gemini-cli");
      expect(result.actualModel).toBe("gemini-3-pro-preview");
      expect(result.quotaPreference).toBe("gemini-cli");
    });

    it("transforms gemini-3.1-pro-low to gemini-3.1-pro-preview for gemini-cli", () => {
      const result = resolveModelForHeaderStyle("gemini-3.1-pro-low", "gemini-cli");
      expect(result.actualModel).toBe("gemini-3.1-pro-preview");
      expect(result.quotaPreference).toBe("gemini-cli");
    });

    it("keeps gemini-3.1-pro-preview-customtools unchanged for gemini-cli", () => {
      const result = resolveModelForHeaderStyle("gemini-3.1-pro-preview-customtools", "gemini-cli");
      expect(result.actualModel).toBe("gemini-3.1-pro-preview-customtools");
      expect(result.quotaPreference).toBe("gemini-cli");
    });
  });

  describe("no transformation needed", () => {
    it("keeps gemini-2.5-flash unchanged for both header styles", () => {
      const antigravity = resolveModelForHeaderStyle("gemini-2.5-flash", "antigravity");
      const cli = resolveModelForHeaderStyle("gemini-2.5-flash", "gemini-cli");
      expect(antigravity.actualModel).toBe("gemini-2.5-flash");
      expect(cli.actualModel).toBe("gemini-2.5-flash");
    });

    it("keeps claude models unchanged (antigravity only)", () => {
      const result = resolveModelForHeaderStyle("claude-opus-4-6-thinking", "antigravity");
      expect(result.actualModel).toBe("claude-opus-4-6-thinking");
    });
  });
});

describe("advertised tier-suffix model IDs", () => {
  const advertised = [
    "claude-opus-5-5-high",
    "claude-sonnet-5-5-high",
    "gemini-4-argon-high",
    "gemini-3.8-flash-high",
    "gpt-oss-120b-medium",
  ];

  it("includes the known advertised IDs and current Flash tiers", () => {
    expect([...ADVERTISED_TIER_SUFFIX_MODEL_IDS]).toEqual(expect.arrayContaining([...advertised, "gemini-3.8-flash-low", "gemini-3.8-flash-medium"]));
  });

  it.each(advertised)("keeps %s intact for antigravity routing", (modelId) => {
    expect(resolveModelForHeaderStyle(modelId, "antigravity").actualModel).toBe(modelId);
    expect(resolveModelForHeaderStyle(`antigravity-${modelId}`, "antigravity").actualModel).toBe(modelId);
    expect(resolveModelWithTier(modelId).actualModel).toBe(modelId);
    expect(resolveModelWithTier(`antigravity-${modelId}`).actualModel).toBe(modelId);
  });

  it("matches with or without the quota prefix, case-insensitively", () => {
    expect(isAdvertisedTierSuffixModel("gemini-3.8-flash-high")).toBe(true);
    expect(isAdvertisedTierSuffixModel("antigravity-GEMINI-3.8-FLASH-HIGH")).toBe(true);
    expect(isAdvertisedTierSuffixModel("gemini-3.8-flash")).toBe(false);
    expect(isAdvertisedTierSuffixModel("gemini-3-flash-high")).toBe(false);
  });

  it("still derives the Gemini 3 thinking level from an advertised suffix", () => {
    const result = resolveModelForHeaderStyle("gemini-3.8-flash-high", "antigravity");
    expect(result.actualModel).toBe("gemini-3.8-flash-high");
    expect(result.thinkingLevel).toBe("high");
    expect(result.quotaPreference).toBe("antigravity");
  });

  it("does not rewrite an advertised ID when a variant thinking budget is applied", () => {
    const result = resolveModelWithVariant("antigravity-gemini-3.8-flash-high", { thinkingBudget: 4096 });
    expect(result.actualModel).toBe("gemini-3.8-flash-high");
    expect(result.thinkingLevel).toBe("low");
  });

  it("keeps legacy tier stripping for non-advertised aliases", () => {
    expect(resolveModelForHeaderStyle("gemini-3-flash-high", "antigravity").actualModel).toBe("gemini-3-flash");
    expect(resolveModelWithTier("claude-opus-4-6-thinking-high").actualModel).toBe("claude-opus-4-6-thinking");
    expect(resolveModelWithTier("gemini-3-pro-high").actualModel).toBe("gemini-3-pro");
    expect(resolveModelForHeaderStyle("gemini-3-pro-high", "antigravity").actualModel).toBe("gemini-3-pro-high");
  });
});

describe("tiered catalog families", () => {
  it("rewrites a collapsed model to the backend tier ID", () => {
    expect(applyTierModelSuffix("gemini-3.8-flash", "low")).toBe("gemini-3.8-flash-low");
    expect(applyTierModelSuffix("gemini-3.8-flash", "medium")).toBe("gemini-3.8-flash-medium");
    expect(applyTierModelSuffix("gemini-3.8-flash", "high")).toBe("gemini-3.8-flash-high");
  });

  it("replaces an existing tier suffix and strips the quota prefix", () => {
    expect(applyTierModelSuffix("gemini-3.8-flash-low", "medium")).toBe("gemini-3.8-flash-medium");
    expect(applyTierModelSuffix("antigravity-gemini-3.8-flash", "high")).toBe("antigravity-gemini-3.8-flash-high");
  });

  it("falls back to low when the requested level is unknown or missing", () => {
    expect(applyTierModelSuffix("gemini-3.8-flash", "turbo")).toBe("gemini-3.8-flash-low");
    expect(applyTierModelSuffix("gemini-3.8-flash", undefined)).toBe("gemini-3.8-flash-low");
  });

  it("never emits a tier the family does not publish", () => {
    expect(applyTierModelSuffix("gemini-3.8-flash", "minimal")).toBe("gemini-3.8-flash-low");
  });

  it("leaves families that publish a real base ID untouched", () => {
    expect(applyTierModelSuffix("gemini-3-flash", "high")).toBe("gemini-3-flash");
    expect(applyTierModelSuffix("claude-sonnet-4-6", "high")).toBe("claude-sonnet-4-6");
  });

  it("rewrites the Gemini 4 Hydrogen tiers, including xhigh", () => {
    expect(applyTierModelSuffix("gemini-4-hydrogen", "low")).toBe("gemini-4-hydrogen-low");
    expect(applyTierModelSuffix("gemini-4-hydrogen", "medium")).toBe("gemini-4-hydrogen-medium");
    expect(applyTierModelSuffix("gemini-4-hydrogen", "high")).toBe("gemini-4-hydrogen-high");
    expect(applyTierModelSuffix("gemini-4-hydrogen", "xhigh")).toBe("gemini-4-hydrogen-xhigh");
    expect(applyTierModelSuffix("antigravity-gemini-4-hydrogen", "xhigh")).toBe("antigravity-gemini-4-hydrogen-xhigh");
    expect(applyTierModelSuffix("gemini-4-hydrogen-high", "xhigh")).toBe("gemini-4-hydrogen-xhigh");
  });

  it("rewrites the Gemini 4 Neon tiers, including xhigh", () => {
    expect(applyTierModelSuffix("gemini-4-neon", "low")).toBe("gemini-4-neon-low");
    expect(applyTierModelSuffix("gemini-4-neon", "medium")).toBe("gemini-4-neon-medium");
    expect(applyTierModelSuffix("gemini-4-neon", "high")).toBe("gemini-4-neon-high");
    expect(applyTierModelSuffix("gemini-4-neon", "xhigh")).toBe("gemini-4-neon-xhigh");
    expect(applyTierModelSuffix("antigravity-gemini-4-neon", "xhigh")).toBe("antigravity-gemini-4-neon-xhigh");
    expect(applyTierModelSuffix("gemini-4-neon-high", "xhigh")).toBe("gemini-4-neon-xhigh");
  });

  it("registers additional families discovered from the catalog", () => {
    registerTierSuffixModelBases([
      ["gemini-9-flash", ["minimal", "low", "high"]],
      ["antigravity-gemini-9.1-flash", ["low", "medium"]],
    ]);
    expect(applyTierModelSuffix("gemini-9-flash", "medium")).toBe("gemini-9-flash-low");
    expect(applyTierModelSuffix("gemini-9.1-flash", "high")).toBe("gemini-9.1-flash-low");
    expect(applyTierModelSuffix("gemini-9.1-flash", "minimal")).toBe("gemini-9.1-flash-low");
  });
});

describe("published tier guard", () => {
  it("keeps a published level and falls back for one the family omits", () => {
    expect(publishedTierFor("gemini-4-hydrogen", "xhigh")).toBe("xhigh");
    expect(publishedTierFor("antigravity-gemini-4-hydrogen", "medium")).toBe("medium");
    expect(publishedTierFor("gemini-4-neon", "xhigh")).toBe("xhigh");
    expect(publishedTierFor("antigravity-gemini-4-neon", "low")).toBe("low");
    // 3.8 Flash stops at high, so the xhigh sentinel must not reach the backend.
    expect(publishedTierFor("gemini-3.8-flash", "xhigh")).toBe("low");
    expect(publishedTierFor("gemini-3.8-flash", "minimal")).toBe("low");
  });

  it("passes through for families the catalog does not collapse", () => {
    expect(publishedTierFor("gemini-3-flash", "medium")).toBe("medium");
    // No published xhigh family, so the sentinel level is clamped to high.
    expect(publishedTierFor("gemini-3-flash", "xhigh")).toBe("high");
    expect(publishedTierFor("claude-sonnet-4-6", undefined)).toBeUndefined();
  });
});

describe("budget to level mapping", () => {
  it("maps the xhigh sentinel and the legacy thresholds", () => {
    expect(budgetToGemini3Level(XHIGH_TIER_BUDGET)).toBe("xhigh");
    expect(budgetToGemini3Level(XHIGH_TIER_BUDGET + 1)).toBe("xhigh");
    expect(budgetToGemini3Level(8192)).toBe("low");
    expect(budgetToGemini3Level(16384)).toBe("medium");
    expect(budgetToGemini3Level(32768)).toBe("high");
  });
});

describe("catalog thinking registry", () => {
  it("marks registered models as thinking-capable with or without the quota prefix", () => {
    registerCatalogThinkingModelIds(["claude-sonnet-9-9", "claude-opus-9-9-high"]);
    expect(isCatalogThinkingModel("claude-sonnet-9-9")).toBe(true);
    expect(isCatalogThinkingModel("antigravity-claude-sonnet-9-9")).toBe(true);
    expect(isCatalogThinkingModel("claude-sonnet-9-9-high")).toBe(true);
    expect(isCatalogThinkingModel("claude-opus-9-9")).toBe(true);
    expect(isCatalogThinkingModel("claude-opus-9-9-low")).toBe(true);
    expect(isCatalogThinkingModel("claude-unregistered-9-9")).toBe(false);
  });
});

describe("getModelFamily", () => {
  it("classifies claude models", () => {
    expect(getModelFamily("claude-sonnet-4-6")).toBe("claude");
    expect(getModelFamily("antigravity-claude-opus-5-5-high")).toBe("claude");
  });

  it("classifies argon and orchestrator models", () => {
    expect(getModelFamily("gemini-4-argon-high")).toBe("gemini-argon");
    expect(getModelFamily("antigravity-gemini-4-argon")).toBe("gemini-argon");
    expect(getModelFamily("gemini-pro-orchestrator-g1-pro")).toBe("gemini-argon");
  });

  it("classifies all remaining gemini models as gemini-flash", () => {
    expect(getModelFamily("gemini-3.8-flash")).toBe("gemini-flash");
    expect(getModelFamily("gemini-4-hydrogen")).toBe("gemini-flash");
    expect(getModelFamily("gemini-4-hydrogen-high")).toBe("gemini-flash");
    expect(getModelFamily("gemini-4-neon")).toBe("gemini-flash");
    expect(getModelFamily("gemini-4-neon-high")).toBe("gemini-flash");
    expect(getModelFamily("gemini-flash-worker-agy")).toBe("gemini-flash");
    expect(getModelFamily("gemini-2.5-pro")).toBe("gemini-flash");
    expect(getModelFamily("gemini-3-flash")).toBe("gemini-flash");
  });
});
