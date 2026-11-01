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

  it("drops further lines once the byte cap is reached", async () => {
    const filePath = join(dir, "debug.log");
    const write = createLogWriter(filePath, 400);

    for (let i = 0; i < 200; i += 1) {
      write(`line ${i} ${"x".repeat(40)}`);
    }

    const content = await readWhenSettled(filePath, "debug log truncated at 400 bytes");
    expect(content).toContain("debug log truncated at 400 bytes");
    expect(content).not.toContain("line 199 ");
    expect(content.split("\n").length).toBeLessThan(20);
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
