/**
 * Tests for persistAccountPool function and account storage error safety.
 *
 * Issue #89: Multi-account login overwrites existing accounts
 * Root cause: loadAccounts() returning null was treated as "no accounts"
 * even when the file exists but couldn't be read (permissions, corruption, etc.)
 *
 * @see https://github.com/NoeFabris/opencode-antigravity-auth/issues/89
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as storageModule from "./storage";
import {
  AccountFileUnreadableError,
  type AccountStorageV4,
  type AccountMetadataV3,
} from "./storage";
import { persistAccountPool } from "../plugin";
import { formatRefreshParts } from "./auth";

vi.mock("proper-lockfile", () => ({
  default: {
    lock: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn(),
      rename: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      copyFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

function createMockAccount(overrides: Partial<AccountMetadataV3> = {}): AccountMetadataV3 {
  return {
    email: "test@example.com",
    refreshToken: "test-refresh-token",
    projectId: "test-project-id",
    managedProjectId: "test-managed-project-id",
    addedAt: Date.now() - 10000,
    lastUsed: Date.now(),
    ...overrides,
  };
}

function createMockStorage(accounts: AccountMetadataV3[], activeIndex = 0): AccountStorageV4 {
  return {
    version: 4,
    accounts,
    activeIndex,
  };
}

function mockAuthResult(
  refreshToken: string,
  email?: string,
  projectId = "test-project-id",
  managedProjectId = "test-managed-project-id",
) {
  return {
    type: "success" as const,
    refresh: formatRefreshParts({ refreshToken, projectId, managedProjectId }),
    access: "test-access-token",
    expires: Date.now() + 3600_000,
    projectId,
    email,
  };
}

describe("loadAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("file not found (ENOENT)", () => {
    it("returns null when file does not exist", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const result = await storageModule.loadAccounts();

      expect(result).toBeNull();
    });
  });

  describe("file exists with valid data", () => {
    it("returns storage for valid V4 file", async () => {
      const mockStorage = createMockStorage([createMockAccount()]);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStorage));

      const result = await storageModule.loadAccounts();

      expect(result).not.toBeNull();
      expect(result?.version).toBe(4);
      expect(result?.accounts).toHaveLength(1);
    });

    it("returns storage with multiple accounts", async () => {
      const mockStorage = createMockStorage([
        createMockAccount({ email: "user1@example.com", refreshToken: "token1" }),
        createMockAccount({ email: "user2@example.com", refreshToken: "token2" }),
      ]);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStorage));

      const result = await storageModule.loadAccounts();

      expect(result?.accounts).toHaveLength(2);
      expect(result?.accounts[0]?.email).toBe("user1@example.com");
      expect(result?.accounts[1]?.email).toBe("user2@example.com");
    });

    it("preserves activeIndex from storage", async () => {
      const mockStorage = createMockStorage(
        [
          createMockAccount({ email: "user1@example.com", refreshToken: "token1" }),
          createMockAccount({ email: "user2@example.com", refreshToken: "token2" }),
        ],
        1,
      );
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockStorage));

      const result = await storageModule.loadAccounts();

      expect(result?.activeIndex).toBe(1);
    });
  });

  describe("error handling - Issue #89 resolution", () => {
    it("throws AccountFileUnreadableError on permission denied (EACCES)", async () => {
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountFileUnreadableError);
      await expect(storageModule.loadAccounts()).rejects.toMatchObject({
        reason: "PERMISSION_DENIED",
      });
    });

    it("throws AccountFileUnreadableError on JSON parse error", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{ invalid json }}}");

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountFileUnreadableError);
      await expect(storageModule.loadAccounts()).rejects.toMatchObject({
        reason: "PARSE_ERROR",
      });
    });

    it("throws AccountFileUnreadableError on invalid storage format", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: 4, notAccounts: [] }));

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountFileUnreadableError);
      await expect(storageModule.loadAccounts()).rejects.toMatchObject({
        reason: "INVALID_FORMAT",
      });
    });

    it("throws AccountFileUnreadableError on unknown version", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: 999, accounts: [] }));

      await expect(storageModule.loadAccounts()).rejects.toThrow(AccountFileUnreadableError);
      await expect(storageModule.loadAccounts()).rejects.toMatchObject({
        reason: "UNKNOWN_VERSION",
      });
    });

    it("includes recovery instructions in error message", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{ corrupt json");

      await expect(storageModule.loadAccounts()).rejects.toThrow(
        /To prevent data loss.*restore from a backup/i,
      );
    });
  });

  describe("migration", () => {
    it("migrates V2 to V4 successfully", async () => {
      const v2Storage = {
        version: 2,
        accounts: [
          {
            refreshToken: "token1",
            addedAt: Date.now() - 10000,
            lastUsed: Date.now(),
          },
        ],
        activeIndex: 0,
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(v2Storage));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await storageModule.loadAccounts();

      expect(result?.version).toBe(4);
      expect(result?.accounts).toHaveLength(1);
    });
  });
});

describe("saveAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves valid storage to disk", async () => {
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith(".gitignore")) {
        return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
      }
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);

    const storage = createMockStorage([createMockAccount()]);
    await storageModule.saveAccounts(storage);

    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]?.[1];
    expect(writtenContent).toBeDefined();
    const parsed = JSON.parse(writtenContent as string);
    expect(parsed.version).toBe(4);
    expect(parsed.accounts).toHaveLength(1);
  });

  it("creates a .bak backup file before replacing existing accounts file", async () => {
    const existing = createMockStorage([createMockAccount({ email: "old@example.com" })]);
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith(".gitignore")) {
        return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
      }
      return JSON.stringify(existing);
    });
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.copyFile).mockResolvedValue(undefined);

    const newStorage = createMockStorage([
      createMockAccount({ email: "old@example.com" }),
      createMockAccount({ email: "new@example.com", refreshToken: "token2" }),
    ]);
    await storageModule.saveAccounts(newStorage);

    expect(fs.copyFile).toHaveBeenCalledWith(
      expect.stringContaining("antigravity-accounts.json"),
      expect.stringContaining("antigravity-accounts.json.bak"),
    );
  });
});

describe("persistAccountPool behavior (Issue #89)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("merging behavior (replaceAll=false)", () => {
    it("merges new account with existing accounts", async () => {
      const existing = createMockStorage([
        createMockAccount({ email: "user1@example.com", refreshToken: "token1" }),
      ]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(existing);
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await persistAccountPool([mockAuthResult("token2", "user2@example.com")], false);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      expect(writeCall).toBeDefined();
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.accounts).toHaveLength(2);
      expect(saved.accounts.map((a) => a.email)).toEqual([
        "user1@example.com",
        "user2@example.com",
      ]);
    });

    it("deduplicates by email, keeping the newest token", async () => {
      const existing = createMockStorage([
        createMockAccount({ email: "user1@example.com", refreshToken: "old-token" }),
      ]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(existing);
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await persistAccountPool([mockAuthResult("new-token", "user1@example.com")], false);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      expect(writeCall).toBeDefined();
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.accounts).toHaveLength(1);
      expect(saved.accounts[0]?.email).toBe("user1@example.com");
      expect(saved.accounts[0]?.refreshToken).toBe("new-token");
    });

    it("deduplicates by refresh token when email not available", async () => {
      const existing = createMockStorage([
        createMockAccount({ email: undefined, refreshToken: "same-token" }),
      ]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(existing);
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await persistAccountPool([mockAuthResult("same-token", undefined)], false);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      expect(writeCall).toBeDefined();
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.accounts).toHaveLength(1);
      expect(saved.accounts[0]?.refreshToken).toBe("same-token");
    });

    it("preserves activeIndex when adding new accounts", async () => {
      const existing = createMockStorage(
        [
          createMockAccount({ email: "u1@example.com", refreshToken: "t1" }),
          createMockAccount({ email: "u2@example.com", refreshToken: "t2" }),
        ],
        1,
      );
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(existing);
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await persistAccountPool([mockAuthResult("t3", "u3@example.com")], false);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.activeIndex).toBe(1);
    });

    it("updates lastUsed timestamp for existing accounts", async () => {
      const existing = createMockStorage([
        createMockAccount({
          email: "u1@example.com",
          refreshToken: "t1",
          lastUsed: new Date("2025-01-01").getTime(),
        }),
      ]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(existing);
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await persistAccountPool([mockAuthResult("t1", "u1@example.com")], false);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.accounts[0]?.lastUsed).toBe(new Date("2026-01-01T12:00:00Z").getTime());
    });
  });

  describe("fresh start behavior (replaceAll=true)", () => {
    it("replaces all existing accounts with new ones", async () => {
      const existing = createMockStorage([
        createMockAccount({ email: "old1@example.com", refreshToken: "t1" }),
        createMockAccount({ email: "old2@example.com", refreshToken: "t2" }),
      ]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(existing);
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await persistAccountPool([mockAuthResult("new-token", "new@example.com")], true);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      expect(writeCall).toBeDefined();
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.accounts).toHaveLength(1);
      expect(saved.accounts[0]?.email).toBe("new@example.com");
    });

    it("resets activeIndex to 0", async () => {
      const existing = createMockStorage(
        [
          createMockAccount({ email: "old1@example.com", refreshToken: "t1" }),
          createMockAccount({ email: "old2@example.com", refreshToken: "t2" }),
        ],
        1,
      );
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(existing);
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await persistAccountPool([mockAuthResult("new-token", "new@example.com")], true);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.activeIndex).toBe(0);
    });

    it("ignores existing accounts file", async () => {
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(createMockStorage([createMockAccount()]));
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await persistAccountPool([mockAuthResult("brand-new", "brand-new@example.com")], true);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.accounts.some((a) => a.email === "test@example.com")).toBe(false);
      expect(saved.accounts[0]?.email).toBe("brand-new@example.com");
    });
  });

  describe("THE BUG: error handling when loadAccounts fails (Issue #89)", () => {
    it("should NOT overwrite accounts when loadAccounts returns null due to permission error", async () => {
      const eacces = new Error("EACCES") as NodeJS.ErrnoException;
      eacces.code = "EACCES";
      vi.mocked(fs.readFile).mockRejectedValue(eacces);

      await expect(
        persistAccountPool([mockAuthResult("token-wont-save", "user@example.com")], false),
      ).rejects.toThrow(AccountFileUnreadableError);

      // Crucial: writeFile for storage was never called!
      const storageWrites = vi
        .mocked(fs.writeFile)
        .mock.calls.filter((c) => !String(c[0]).endsWith(".gitignore"));
      expect(storageWrites).toHaveLength(0);
    });

    it("should throw error when file exists but cannot be read", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{ broken json !!!");

      await expect(
        persistAccountPool([mockAuthResult("token", "user@example.com")], false),
      ).rejects.toThrow(AccountFileUnreadableError);

      const storageWrites = vi
        .mocked(fs.writeFile)
        .mock.calls.filter((c) => !String(c[0]).endsWith(".gitignore"));
      expect(storageWrites).toHaveLength(0);
    });

    it("should include recovery instructions in error message", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{ broken json !!!");

      await expect(
        persistAccountPool([mockAuthResult("token", "user@example.com")], false),
      ).rejects.toThrow(/To prevent data loss.*restore from a backup/i);
    });

    it("should only treat ENOENT as 'safe to create new file'", async () => {
      const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
      enoent.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(enoent);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await expect(
        persistAccountPool([mockAuthResult("first-token", "first@example.com")], false),
      ).resolves.not.toThrow();

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      expect(writeCall).toBeDefined();
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.accounts).toHaveLength(1);
      expect(saved.accounts[0]?.email).toBe("first@example.com");
    });
  });
});

describe("TUI flow integration (Issue #89)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("account persistence after OAuth", () => {
    it("should merge new account with existing accounts in TUI flow", async () => {
      const existing = createMockStorage([
        createMockAccount({ email: "tui-existing@example.com", refreshToken: "tui-token-1" }),
      ]);
      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        if (String(filePath).endsWith(".gitignore")) {
          return storageModule.GITIGNORE_ENTRIES.join("\n") + "\n";
        }
        return JSON.stringify(existing);
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      // TUI flow always calls persistAccountPool with replaceAll=false
      await persistAccountPool([mockAuthResult("tui-token-2", "tui-new@example.com")], false);

      const writeCall = vi.mocked(fs.writeFile).mock.calls.find((c) =>
        String(c[0]).includes(".tmp"),
      );
      const saved = JSON.parse(writeCall![1] as string) as AccountStorageV4;
      expect(saved.accounts).toHaveLength(2);
      expect(saved.accounts.map((a) => a.email)).toContain("tui-existing@example.com");
      expect(saved.accounts.map((a) => a.email)).toContain("tui-new@example.com");
    });

    it("should reject safely without data loss when existing accounts cannot be loaded", async () => {
      const eacces = new Error("EACCES") as NodeJS.ErrnoException;
      eacces.code = "EACCES";
      vi.mocked(fs.readFile).mockRejectedValue(eacces);

      await expect(
        persistAccountPool([mockAuthResult("tui-token", "tui@example.com")], false),
      ).rejects.toThrow(AccountFileUnreadableError);

      const storageWrites = vi
        .mocked(fs.writeFile)
        .mock.calls.filter((c) => !String(c[0]).endsWith(".gitignore"));
      expect(storageWrites).toHaveLength(0);
    });

    it("should handle empty results gracefully as a no-op", async () => {
      await expect(persistAccountPool([], false)).resolves.not.toThrow();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });
});

describe("regression tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("first-time user experience", () => {
    it("should work correctly when no accounts file exists (ENOENT)", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const result = await storageModule.loadAccounts();
      expect(result).toBeNull();

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const newStorage = createMockStorage([createMockAccount()]);
      await expect(storageModule.saveAccounts(newStorage)).resolves.not.toThrow();
    });
  });

  describe("normal multi-account workflow", () => {
    it("should load existing accounts correctly", async () => {
      const existingStorage = createMockStorage([
        createMockAccount({ email: "existing@example.com" }),
      ]);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingStorage));

      const result = await storageModule.loadAccounts();

      expect(result).not.toBeNull();
      expect(result?.accounts).toHaveLength(1);
      expect(result?.accounts[0]?.email).toBe("existing@example.com");
    });

    it("should preserve all accounts when saving", async () => {
      const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
      enoent.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(enoent);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const storage = createMockStorage([
        createMockAccount({ email: "user1@example.com", refreshToken: "token1" }),
        createMockAccount({ email: "user2@example.com", refreshToken: "token2" }),
        createMockAccount({ email: "user3@example.com", refreshToken: "token3" }),
      ]);

      await storageModule.saveAccounts(storage);

      expect(fs.writeFile).toHaveBeenCalledTimes(2);

      const tmpWriteCall = vi.mocked(fs.writeFile).mock.calls.find((call) =>
        (call[0] as string).includes(".tmp"),
      );
      expect(tmpWriteCall).toBeDefined();
      const parsed = JSON.parse(tmpWriteCall![1] as string);
      expect(parsed.accounts).toHaveLength(3);

      const gitignoreWriteCall = vi.mocked(fs.writeFile).mock.calls.find((call) =>
        (call[0] as string).includes(".gitignore"),
      );
      expect(gitignoreWriteCall).toBeDefined();
    });
  });
});
