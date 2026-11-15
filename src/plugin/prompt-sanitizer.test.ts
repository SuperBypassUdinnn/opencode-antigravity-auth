import { describe, expect, it } from "vitest";

import { sanitizeCompetingClientFingerprints } from "./request";

function envelope(systemText: string): string {
  return JSON.stringify({
    project: "aicode-consumers",
    model: "gemini-3.8-flash-high",
    request: { systemInstruction: { parts: [{ text: systemText }] } },
  });
}

function systemOf(bodyText: string): string {
  return JSON.parse(bodyText).request.systemInstruction.parts[0].text;
}

describe("sanitizeCompetingClientFingerprints", () => {
  it("neutralizes the tools.opencode namespace that Google rejects", () => {
    const input = envelope("Code Mode tools: tools.opencode.session_move({ sessionID }) and more tools.opencode.read.");
    const { body, replacements } = sanitizeCompetingClientFingerprints(input);

    expect(replacements).toBe(2);
    const text = systemOf(body);
    expect(text).toContain("tools.session_move");
    expect(text).not.toContain("tools.opencode");
  });

  it("neutralizes identity claims of competing clients", () => {
    for (const claim of ["You are opencode, a coding agent.", "You are OpenCode.", "You are claude code, a CLI."]) {
      const { body, replacements } = sanitizeCompetingClientFingerprints(envelope(claim));
      expect(replacements).toBe(1);
      // Only the matched name is replaced; the rest of the sentence survives.
      expect(systemOf(body)).not.toMatch(/opencode|claude code/i);
      expect(systemOf(body)).toContain("You are the coding agent");
    }
  });

  it("leaves ordinary mentions of opencode untouched", () => {
    const text = "This session uses opencode for coding tasks.";
    const { body, replacements } = sanitizeCompetingClientFingerprints(envelope(text));

    expect(replacements).toBe(0);
    expect(systemOf(body)).toBe(text);
  });

  it("leaves a body without a system instruction untouched", () => {
    const input = JSON.stringify({ project: "aicode-consumers", model: "m", request: {} });
    const { body, replacements } = sanitizeCompetingClientFingerprints(input);

    expect(replacements).toBe(0);
    expect(body).toBe(input);
  });

  it("leaves non-JSON bodies untouched", () => {
    const input = "not json but mentions tools.opencode";
    const { body, replacements } = sanitizeCompetingClientFingerprints(input);

    expect(replacements).toBe(0);
    expect(body).toBe(input);
  });

  it("also sanitizes an unwrapped payload with a top-level system instruction", () => {
    const input = JSON.stringify({ systemInstruction: { parts: [{ text: "tools.opencode.read" }] } });
    const { body, replacements } = sanitizeCompetingClientFingerprints(input);

    expect(replacements).toBe(1);
    expect(JSON.parse(body).systemInstruction.parts[0].text).toBe("tools.read");
  });
});
