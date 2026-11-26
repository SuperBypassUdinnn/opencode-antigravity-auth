import { describe, expect, it } from "vitest"
import { OPENCODE_V2_MODEL_DEFINITIONS, buildAccountModelDefinitions, isPreDiscoveryGatedModel } from "./models-v2"
import { XHIGH_TIER_BUDGET } from "./models"
import { isCatalogThinkingModel, resolveModelForHeaderStyle } from "../transform/model-resolver"

describe("OpenCode V2 models", () => {
  it("registers tools, modalities, and V2 variant overlays", () => {
    expect(OPENCODE_V2_MODEL_DEFINITIONS["gemini-2.5-flash"]).toBeUndefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3-flash"]).toMatchObject({
      package: "aisdk:@ai-sdk/google",
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: expect.arrayContaining([{ id: "high", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } }]),
    })
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-claude-opus-4-6-thinking"]?.variants).toContainEqual({
      id: "max", settings: { thinkingConfig: { thinkingBudget: 32768 } },
    })
  })

  it("uses account metadata and preserves backend tiers while filtering unavailable models", () => {
    const catalog = buildAccountModelDefinitions({
      "claude-opus-5-5-high": { displayName: "Claude Opus 5.5 High", maxTokens: 1000000, maxOutputTokens: 128000 },
      "gemini-3.9-flash-medium": { displayName: "Gemini 3.9 Flash (Medium)", maxTokens: 1048576, maxOutputTokens: 65536 },
      "gemini-4-argon-disabled": { disabled: true },
      "gemini-3.8-flash-tiered": {},
      "gemini-3.1-flash-image": {},
      "gemini-2.5-pro": { selectable: false },
      "gemini-pro-orchestrator-g1-pro": { displayName: "Orchestrator (Argon)", selectable: true },
      "gemini-4-helper": { displayName: "Gemini 4 Helper (Orchestrator)", selectable: true },
      "tab_flash_lite_preview": {},
    })
    expect(Object.keys(catalog)).toEqual(["antigravity-claude-opus-5-5-high", "antigravity-gemini-3.9-flash-medium"])
    expect(catalog["antigravity-claude-opus-5-5-high"]).toMatchObject({
      limit: { context: 1000000, output: 128000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      variants: [],
    })
    expect(resolveModelForHeaderStyle("antigravity-gemini-3.9-flash-medium", "antigravity").actualModel).toBe("gemini-3.9-flash-medium")
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-4-hydrogen-high"]).toBeUndefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-4-hydrogen"]?.variants).toEqual([
      { id: "low", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
      { id: "medium", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } } },
      { id: "high", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } },
      { id: "xhigh", settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: XHIGH_TIER_BUDGET } } },
    ])
  })

  it("collapses per-tier catalog families into one model with a variant per tier", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-4-carbon-low": { displayName: "Gemini 4 Carbon (Low)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-carbon-medium": { displayName: "Gemini 4 Carbon (Medium)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-4-carbon"])
    expect(catalog["antigravity-gemini-4-carbon"]).toMatchObject({
      name: "Gemini 4 Carbon (Antigravity)",
      limit: { context: 1048576, output: 262144 },
      variants: [
        { id: "low", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
        { id: "medium", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } } },
        { id: "high", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } },
      ],
    })
    expect(catalog["antigravity-gemini-4-carbon-high"]).toBeUndefined()
  })

  it("collapses the Gemini 4 Hydrogen tiers into one model without the tiered duplicates", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-4-hydrogen-disabled": { displayName: "Gemini 4 Hydrogen", disabled: true },
      "gemini-4-hydrogen-low": { displayName: "Gemini 4 Hydrogen (Low)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-hydrogen-medium": { displayName: "Gemini 4 Hydrogen (Medium)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-hydrogen-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-hydrogen-tiered-high": { displayName: "Gemini 4 Hydrogen (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-hydrogen-tiered-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-hydrogen-sonar": { displayName: "Gemini 4 Hydrogen Sonar", selectable: false },
      "gemini-flash-worker-agy": { displayName: "Gemini 4 Hydrogen (Orchestrator)", selectable: false },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-4-hydrogen"])
    expect(catalog["antigravity-gemini-4-hydrogen"]).toMatchObject({
      name: "Gemini 4 Hydrogen (Antigravity)",
      limit: { context: 1048576, output: 262144 },
      variants: [
        { id: "low", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
        { id: "medium", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } } },
        { id: "high", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } },
        { id: "xhigh", settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: XHIGH_TIER_BUDGET } } },
      ],
    })
  })

  it("collapses the Gemini 4 Neon tiers into one model with four variants", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-4-neon-low": { displayName: "Gemini 4 Neon (Low)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-neon-medium": { displayName: "Gemini 4 Neon (Medium)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-neon-high": { displayName: "Gemini 4 Neon (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-neon-xhigh": { displayName: "Gemini 4 Neon (XHigh)", maxTokens: 1048576, maxOutputTokens: 262144 },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-4-neon"])
    expect(catalog["antigravity-gemini-4-neon"]).toMatchObject({
      name: "Gemini 4 Neon (Antigravity)",
      limit: { context: 1048576, output: 262144 },
      variants: [
        { id: "low", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
        { id: "medium", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } } },
        { id: "high", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } },
        { id: "xhigh", settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: XHIGH_TIER_BUDGET } } },
      ],
    })
  })

  it("collapses the Gemini 4 Carbon tiers into one model with three variants", () => {
    const catalog = buildAccountModelDefinitions({
      "gemini-4-carbon-low": { displayName: "Gemini 4 Carbon (Low)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-carbon-medium": { displayName: "Gemini 4 Carbon (Medium)", maxTokens: 1048576, maxOutputTokens: 262144 },
      "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
    })

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-4-carbon"])
    expect(catalog["antigravity-gemini-4-carbon"]).toMatchObject({
      name: "Gemini 4 Carbon (Antigravity)",
      limit: { context: 1048576, output: 262144 },
      variants: [
        { id: "low", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } },
        { id: "medium", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } } },
        { id: "high", settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } } },
      ],
    })
  })

  it("filters out retired model bases even when still returned by the backend", () => {
    const retiredBases = new Set(["gemini-4-argon", "gemini-3.8-flash", "gpt-oss-120b"])
    const catalog = buildAccountModelDefinitions(
      {
        "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", maxTokens: 1048576, maxOutputTokens: 65535 },
        "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)", maxTokens: 1048576, maxOutputTokens: 65536 },
        "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", maxTokens: 1048576, maxOutputTokens: 65536 },
        "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", maxTokens: 131072, maxOutputTokens: 32768 },
        "gemini-4-carbon-low": { displayName: "Gemini 4 Carbon (Low)", maxTokens: 1048576, maxOutputTokens: 262144 },
        "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon (High)", maxTokens: 1048576, maxOutputTokens: 262144 },
      },
      { retiredBases },
    )

    expect(Object.keys(catalog)).toEqual(["antigravity-gemini-4-carbon"])
  })
})

describe("pre-discovery model gate", () => {
  it("includes the three new pro models in the fallback definitions", () => {
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-4-argon"]).toBeDefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-4-carbon"]).toBeDefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-4-hydrogen"]).toBeDefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-4-neon"]).toBeDefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-claude-sonnet-5-5"]).toBeDefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-claude-opus-5-5-thinking"]).toBeDefined()
  })

  it("flags gated bases regardless of prefix case and tier suffix", () => {
    expect(isPreDiscoveryGatedModel("antigravity-gemini-4-argon-high")).toBe(true)
    expect(isPreDiscoveryGatedModel("antigravity-gemini-4-argon")).toBe(true)
    expect(isPreDiscoveryGatedModel("antigravity-gemini-4-carbon-high")).toBe(true)
    expect(isPreDiscoveryGatedModel("antigravity-gemini-4-carbon")).toBe(true)
    expect(isPreDiscoveryGatedModel("antigravity-gemini-4-neon-high")).toBe(true)
    expect(isPreDiscoveryGatedModel("antigravity-gemini-4-neon")).toBe(true)
    expect(isPreDiscoveryGatedModel("antigravity-claude-sonnet-5-5")).toBe(true)
    expect(isPreDiscoveryGatedModel("ANTIGRAVITY-CLAUDE-OPUS-5-5-THINKING-HIGH")).toBe(true)
    expect(isPreDiscoveryGatedModel("antigravity-claude-opus-5-5-high")).toBe(true)
    expect(isPreDiscoveryGatedModel("antigravity-gemini-4-hydrogen")).toBe(false)
    expect(isPreDiscoveryGatedModel("antigravity-gemini-3-flash-high")).toBe(false)
    expect(isPreDiscoveryGatedModel("antigravity-claude-sonnet-4-6")).toBe(false)
  })
})

describe("catalog thinking registration", () => {
  it("registers catalog models whose displayName marks them as (Thinking)", () => {
    buildAccountModelDefinitions({
      "claude-sonnet-9-8": { displayName: "Claude Sonnet 9.8 (Thinking)" },
      "claude-plain-9-8": { displayName: "Claude Plain 9.8" },
      "claude-sonnet-5-5-high": { displayName: "Claude Sonnet 5.5 (High)", supportsThinking: true },
    })
    expect(isCatalogThinkingModel("claude-sonnet-9-8")).toBe(true)
    expect(isCatalogThinkingModel("claude-plain-9-8")).toBe(false)
    expect(isCatalogThinkingModel("claude-sonnet-5-5")).toBe(true)
    expect(isCatalogThinkingModel("claude-sonnet-5-5-high")).toBe(true)
    expect(isCatalogThinkingModel("claude-sonnet-5-5-low")).toBe(true)
  })
})
