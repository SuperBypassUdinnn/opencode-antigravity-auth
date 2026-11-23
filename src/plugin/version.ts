/**
 * Remote Antigravity Hub version fetcher.
 *
 * Resolution strategy:
 *   1. Hub auto-updater manifest (electron-builder YAML, `version:` field)
 *   2. Hardcoded fallback in constants.ts
 *
 * Manifest versions below ANTIGRAVITY_MINIMUM_VERSION are rejected because
 * Cloud Code no longer serves newer models to those clients.
 *
 * Called once at plugin startup to ensure headers use the latest
 * supported version, avoiding "version no longer supported" errors.
 *
 * @see https://github.com/router-for-me/CLIProxyAPI (internal/misc/antigravity_version.go)
 */

import {
  ANTIGRAVITY_MINIMUM_VERSION,
  getAntigravityVersion,
  setAntigravityChangelist,
  setAntigravityVersion,
} from "../constants";
import { createLogger } from "./logger";
import { getConfigDir } from "./storage";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ANTIGRAVITY_HUB_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";

export interface VersionCacheEntry {
  version: string;
  changelist?: string;
  updatedAt: number;
}

const VERSION_CACHE_FILENAME = "antigravity-version-cache.json";

function getVersionCachePath(): string {
  return join(getConfigDir(), VERSION_CACHE_FILENAME);
}

export function loadCachedVersion(): VersionCacheEntry | null {
  try {
    const cachePath = getVersionCachePath();
    if (!existsSync(cachePath)) return null;
    const raw = readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw) as Partial<VersionCacheEntry>;
    if (typeof data.version === "string" && isSupportedAntigravityVersion(data.version) && typeof data.updatedAt === "number") {
      return {
        version: data.version,
        changelist: typeof data.changelist === "string" ? data.changelist : undefined,
        updatedAt: data.updatedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCachedVersion(version: string, changelist?: string): void {
  try {
    const cachePath = getVersionCachePath();
    const payload: VersionCacheEntry = {
      version,
      changelist: changelist || undefined,
      updatedAt: Date.now(),
    };
    writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // Non-critical file write
  }
}

const MANIFEST_HEADERS = {
  "User-Agent": "electron-builder",
  "Cache-Control": "no-cache",
} as const;
const FETCH_TIMEOUT_MS = 5000;
const MAX_MANIFEST_BYTES = 4096;
const STRICT_VERSION_REGEX = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const VERSION_KEY = "version:";

/**
 * Returns true for plain `major.minor.patch` versions (no prefixes, suffixes, or pre-release tags).
 */
export function isStrictVersion(value: string): boolean {
  return STRICT_VERSION_REGEX.test(value);
}

/**
 * Compares two strict versions numerically. Returns a negative number, zero, or a positive number.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Returns true when the version is strict and at least the Cloud Code minimum.
 */
export function isSupportedAntigravityVersion(version: string): boolean {
  return isStrictVersion(version) && compareVersions(version, ANTIGRAVITY_MINIMUM_VERSION) >= 0;
}

/**
 * Extracts the top-level `version:` value from an electron-builder update manifest.
 * Indented keys (for example inside `files:`) are ignored. Returns null when the
 * value is missing or not a strict `major.minor.patch` version.
 */
export function parseHubManifestVersion(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(VERSION_KEY)) continue;

    let value = line.slice(VERSION_KEY.length).trim();
    const commentIndex = value.search(/\s#/);
    if (commentIndex >= 0) {
      value = value.slice(0, commentIndex).trim();
    }
    const quote = value[0];
    if ((quote === "'" || quote === "\"") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    return isStrictVersion(value) ? value : null;
  }
  return null;
}

/**
 * Extracts the build changelist from the manifest download path
 * (`.../antigravity-hub/<version>-<changelist>/...`). The Hub appends its CL to
 * the User-Agent, and a missing CL distinguishes an unknown build from a real
 * client, so the plugin resolves it from the same manifest as the version.
 * Returns null when the manifest carries no recognizable path.
 */
export function parseHubManifestChangelist(text: string): string | null {
  const match = text.match(/antigravity-hub\/\d{1,6}\.\d{1,6}\.\d{1,6}-(\d{6,20})\//);
  return match?.[1] ?? null;
}

/**
 * Reads at most maxBytes of the body. A truncated read drops its trailing partial line.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - received;
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, remaining));
        truncated = true;
        break;
      }
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  if (!truncated) {
    return text + decoder.decode();
  }
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
}

/**
 * Fetches the latest Hub version from the auto-updater manifest.
 * Returns null on network errors, non-OK responses, or unparseable manifests.
 */
export async function fetchHubManifestVersion(url = ANTIGRAVITY_HUB_MANIFEST_URL): Promise<string | null> {
  return (await fetchHubManifestInfo(url))?.version ?? null;
}

/**
 * Fetches the manifest and reads both the version and the build changelist.
 */
async function fetchHubManifestInfo(url = ANTIGRAVITY_HUB_MANIFEST_URL): Promise<{ version: string; changelist: string | null } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: MANIFEST_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await readBoundedText(response, MAX_MANIFEST_BYTES);
    const version = parseHubManifestVersion(text);
    if (!version) return null;
    return { version, changelist: parseHubManifestChangelist(text) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the latest Antigravity version and update the global constant.
 * Safe to call before logger is initialized (will silently skip logging).
 */
export async function initAntigravityVersion(options: { ignoreCache?: boolean } = {}): Promise<void> {
  const log = createLogger("version");
  const fallback = getAntigravityVersion();

  // Seed with persisted cache if available and not yet set
  const cached = options.ignoreCache ? null : loadCachedVersion();
  if (cached && isSupportedAntigravityVersion(cached.version)) {
    setAntigravityVersion(cached.version);
    setAntigravityChangelist(cached.changelist);
  }

  const info = await fetchHubManifestInfo();
  if (!info) {
    const active = getAntigravityVersion();
    setAntigravityVersion(active);
    log.info("version-fetch-failed", { fallback: active });
    return;
  }

  if (!isSupportedAntigravityVersion(info.version)) {
    const active = getAntigravityVersion();
    setAntigravityVersion(fallback, true);
    setAntigravityChangelist(undefined);
    log.warn("version-below-minimum", { version: info.version, minimum: ANTIGRAVITY_MINIMUM_VERSION, fallback });
    return;
  }

  const previous = getAntigravityVersion();
  if (info.version !== previous) {
    log.info("version-updated", { version: info.version, source: "manifest", previous });
  } else {
    log.debug("version-unchanged", { version: info.version, source: "manifest" });
  }
  setAntigravityVersion(info.version, true);
  setAntigravityChangelist(info.changelist ?? undefined);
  saveCachedVersion(info.version, info.changelist ?? undefined);
}

export const ANTIGRAVITY_VERSION_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
let lastVersionCheck = 0;
let pendingVersionCheck: Promise<void> | undefined;

/** Coalesce startup checks and refresh long-lived hosts every few hours. */
export async function refreshAntigravityVersion(options: { force?: boolean } = {}): Promise<void> {
  if (pendingVersionCheck) return pendingVersionCheck;
  if (!options.force && lastVersionCheck && Date.now() - lastVersionCheck < ANTIGRAVITY_VERSION_REFRESH_INTERVAL_MS) return;
  pendingVersionCheck = initAntigravityVersion().finally(() => {
    lastVersionCheck = Date.now();
    pendingVersionCheck = undefined;
  });
  return pendingVersionCheck;
}
