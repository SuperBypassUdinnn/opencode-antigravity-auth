import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "./schema";

describe("cli_first config", () => {
  it("includes cli_first default in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG).toHaveProperty("cli_first", false);
  });

  it("documents cli_first in the JSON schema", () => {
    const schemaPath = new URL("../../../assets/antigravity.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };

    const cliFirst = schema.properties?.cli_first;
    expect(cliFirst).toBeDefined();
    expect(cliFirst).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(typeof cliFirst?.description).toBe("string");
    expect(cliFirst?.description?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("claude_prompt_auto_caching config", () => {
  it("includes claude_prompt_auto_caching default in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG).toHaveProperty("claude_prompt_auto_caching", false);
  });

  it("documents claude_prompt_auto_caching in the JSON schema", () => {
    const schemaPath = new URL("../../../assets/antigravity.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };

    const claudePromptAutoCaching = schema.properties?.claude_prompt_auto_caching;
    expect(claudePromptAutoCaching).toBeDefined();
    expect(claudePromptAutoCaching).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(typeof claudePromptAutoCaching?.description).toBe("string");
    expect(claudePromptAutoCaching?.description?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("free_account_first config", () => {
  it("defaults free_account_first to true so free accounts start their weekly window", () => {
    expect(DEFAULT_CONFIG).toHaveProperty("free_account_first", true);
  });

  it("documents free_account_first in the JSON schema", () => {
    const schemaPath = new URL("../../../assets/antigravity.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };

    const freeAccountFirst = schema.properties?.free_account_first;
    expect(freeAccountFirst).toBeDefined();
    expect(freeAccountFirst).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(typeof freeAccountFirst?.description).toBe("string");
    expect(freeAccountFirst?.description?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("weekly_soft_quota_threshold_percent config", () => {
  it("defaults weekly_soft_quota_threshold_percent to 99 (1% remaining)", () => {
    expect(DEFAULT_CONFIG).toHaveProperty("weekly_soft_quota_threshold_percent", 99);
  });

  it("documents weekly_soft_quota_threshold_percent in the JSON schema", () => {
    const schemaPath = new URL("../../../assets/antigravity.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };

    const weeklySoft = schema.properties?.weekly_soft_quota_threshold_percent;
    expect(weeklySoft).toBeDefined();
    expect(weeklySoft).toMatchObject({
      type: "number",
      default: 99,
    });
    expect(typeof weeklySoft?.description).toBe("string");
    expect(weeklySoft?.description?.length ?? 0).toBeGreaterThan(0);
  });
});
