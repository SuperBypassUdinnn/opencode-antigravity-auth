/**
 * Builds the "Quota resets at ..." clause shared by the quota-exhausted error
 * and the 429 toast. Empty input yields no clause, unparsable strings keep
 * Google's raw text, and an already-expired window reads as reset.
 */
export function formatQuotaResetSuffix(resetTime?: string | null): string {
  if (!resetTime) return "";
  if (Number.isNaN(Date.parse(resetTime))) return ` Quota resets at ${resetTime}.`;
  const stamp = formatResetStamp(resetTime);
  return stamp === "already resetting"
    ? " The quota window has already reset."
    : ` Quota resets at ${stamp} (local time).`;
}

export function formatResetStamp(
  resetTime?: string | null,
  opts?: { now?: number; timeZone?: string },
): string {
  if (!resetTime) return "";
  const parsed = Date.parse(resetTime);
  if (Number.isNaN(parsed)) return resetTime;
  const now = opts?.now ?? Date.now();
  if (parsed <= now) return "already resetting";

  const parts = new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: opts?.timeZone,
  }).formatToParts(new Date(parsed));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const stamp = `${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;

  const ms = parsed - now;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const remaining = totalSeconds % 86400;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;

  let relative: string;
  if (days > 0) {
    relative = `in ${days}d ${hours}h`;
  } else if (hours > 0) {
    relative = `in ${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    relative = `in ${minutes}m`;
  } else {
    relative = `in ${seconds}s`;
  }

  return `${stamp}, ${relative}`;
}

/**
 * Formats a two-tier display for Pro accounts:
 * e.g.:
 * "5h: 62% (resets 11 Nov 20:20, in 2h 10m) | 1w: 88% (resets 18 Nov 15:20, in 6d 21h)"
 */
export function formatTwoTierQuotaReport(
  shortQuota: { remainingFraction?: number; resetTime?: string },
  weeklyQuota?: { remainingFraction?: number; resetTime?: string },
  opts?: { now?: number; timeZone?: string },
): string {
  const shortPct = shortQuota.remainingFraction === undefined ? "unknown" : `${Math.round(shortQuota.remainingFraction * 100)}%`;
  const shortStamp = formatResetStamp(shortQuota.resetTime, opts);
  const shortPart = shortStamp ? `${shortPct} (resets ${shortStamp})` : shortPct;

  if (weeklyQuota && (weeklyQuota.remainingFraction !== undefined || weeklyQuota.resetTime)) {
    const weeklyPct = weeklyQuota.remainingFraction === undefined ? "unknown" : `${Math.round(weeklyQuota.remainingFraction * 100)}%`;
    const weeklyStamp = formatResetStamp(weeklyQuota.resetTime, opts);
    const weeklyPart = weeklyStamp ? `${weeklyPct} (resets ${weeklyStamp})` : weeklyPct;
    return `5h: ${shortPart} | 1w: ${weeklyPart}`;
  }

  return `5h: ${shortPart}`;
}
