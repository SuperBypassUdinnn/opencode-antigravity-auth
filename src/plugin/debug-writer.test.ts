import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogWriter } from "./debug.ts";

async function readWhenSettled(filePath: string, marker: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let content = "";
  while (Date.now() < deadline) {
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      content = "";
    }
    if (content.includes(marker)) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return content;
}

describe("createLogWriter size cap", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "antigravity-debug-writer-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the tail of the run once the byte cap is reached", async () => {
    const filePath = join(dir, "debug.log");
    // Cap the retained tail explicitly so the test exercises the same split the
    // real 32 MB cap uses (cap much larger than the tail budget).
    const write = createLogWriter(filePath, 4_000, 500);

    for (let i = 0; i < 200; i += 1) {
      write(`line ${i} ${"x".repeat(40)}`);
    }

    const content = await readWhenSettled(filePath, "line 199 ");
    // The decisive ending of the run survives the cap: the last attempt is
    // exactly what a diagnosis needs.
    expect(content).toContain("line 199 ");
    expect(content).toContain("keeping only the most recent 500 characters");
    // Older lines are dropped, so the window stays bounded.
    expect(content).not.toContain("line 0 ");
    expect(content.length).toBeLessThanOrEqual(4_000);
  });

  it("keeps writing while the file stays under the cap", async () => {
    const filePath = join(dir, "debug.log");
    const write = createLogWriter(filePath, 10_000);

    write("first line");
    write("second line");

    const content = await readWhenSettled(filePath, "second line");
    expect(content).toContain("first line");
    expect(content).not.toContain("debug log truncated");
  });

  it("stays silent without a path", () => {
    const write = createLogWriter(undefined);

    expect(() => write("ignored")).not.toThrow();
  });
});
