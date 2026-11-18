# Antigravity + Gemini CLI OAuth Plugin for Opencode

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-antigravity-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm downloads](https://img.shields.io/npm/dw/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![X (Twitter)](https://img.shields.io/badge/X-@dopesalmon-000000?style=flat&logo=x)](https://x.com/dopesalmon)

Enable Opencode to authenticate against **Antigravity** (Google's IDE) via OAuth so you can use Antigravity rate limits and access models like `gemini-3.1-pro` and `claude-opus-4-6-thinking` with your Google credentials.

Unofficial plugin. Google may restrict accounts using third-party clients.

## Setup

Requires OpenCode **2.1.2+** and Node.js **20+**.

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-antigravity-auth@2.1.1"]
}
```

Then run:

```sh
opencode auth login google
```

Choose **Google OAuth (Antigravity)**. Existing accounts are reused.

To use a local checkout, run `npm ci && npm run build` and replace the package name above with the checkout's absolute path.

## Use

```sh
opencode models
opencode run --model=google/antigravity-gemini-3.8-flash#high "Hello"
opencode run --model=google/antigravity-gemini-4-hydrogen#xhigh "Hello"
opencode run --model=google/antigravity-claude-opus-4-6-thinking#max "Hello"
opencode run --model=google/antigravity-claude-sonnet-5-5#high "Hello"
```

Models are discovered from your enabled accounts and cached for an hour. Availability depends on your Google plan. Select an `antigravity-*` model for Google OAuth. Native Google API-key models are hidden while Antigravity OAuth is selected and return when you switch to an API-key connection.

Inside OpenCode, open **`/antigravity`** (or **`/ag`**) to:

- See logged-in accounts and the current selection.
- Check Antigravity and Gemini CLI quotas and reset times.
- Add, select, enable, disable, re-authenticate, or delete an account.
- Refresh the model list.

Accounts are stored in `~/.config/opencode/antigravity-accounts.json`. Back up this file before moving machines; it contains credentials. Disabling an account excludes it from rotation and routine quota checks.

## Fork Enhancements and Fixes

This fork includes critical stability, protocol compatibility, model architecture, and quota management patches relative to the upstream repository.

### Watchdog and SSE Stream Stability

- **45-Second Watchdog Protection**: Implemented silent-wait budgeting that strictly caps cumulative waiting per request within OpenCode's 45-second event-stream watchdog timeout window. This prevents client disconnects and infinite server restart loops during upstream stalls.
- **Account Selection Spin Guards**: Prevents spinning loops in the multi-account rotation logic when candidate accounts are blocked by cooldowns, rate limits, or soft quotas.
- **Body Stall Guard and Bounded Retries**: Automatically aborts stalled chat requests after body idle thresholds, handles silent upstream response phases, and bounds cumulative retry attempts per request.
- **In-Flight Stream Persistence**: Background model discovery executes concurrently without interrupting active chat streams, and in-flight requests cleanly transition across runtime reloads.

### Streaming Protocol and Finish Reason Integrity

- **Unified Gemini SSE Synthetic Error Format**: Routes all synthetic error responses (license benching, repeated 403 fail-fast rejections, context length exceeded) through `createSyntheticGeminiErrorResponse`. Because OpenCode processes all Antigravity models (including Claude) via `@ai-sdk/google`, emitting Anthropic SSE previously caused "The provider response ended with an unknown finish reason."
- **Top-Level SSE Chunk Unwrapping**: Strips outer `{ response: ... }` wrappers from mid-stream error events and synthetic usage metadata in the stream transformer, ensuring `@ai-sdk/google` properly parses `candidates` and `usageMetadata`.
- **Truncated Stream Recovery and Terminal STOP Chunks**: Monitors `hasSeenFinishReason` and `hasSeenCandidateContent`. If an HTTP 200 SSE stream is truncated mid-stream by upstream without a finish reason, the transformer injects a closing chunk with `finishReason: "STOP"` (and diagnostic explanations if no tokens were emitted) plus fallback `usageMetadata`, preventing unknown finish reason failures and infinite retries.
- **Gemini 4 Thought Signature Caching**: Extends thought signature caching (`shouldCacheThinkingSignatures`) to Gemini 4 models (`gemini-4-argon`, `gemini-4-hydrogen`) in addition to Gemini 3 and Claude, preserving thought context across multi-turn tool calling loops.

### Extended Model Architecture and Tier Collapsing

- **Gemini 4 Argon (`antigravity-gemini-4-argon`)**: Managed in a dedicated weekly-only quota bucket with tier routing (`low`, `medium`, `high`) and pre-discovery gating.
- **Gemini 4 Hydrogen (`antigravity-gemini-4-hydrogen`)**: Consolidated into a single model entry supporting `low`, `medium`, `high`, and `xhigh` variants. Employs a numeric budget sentinel (`XHIGH_TIER_BUDGET = 65535`) to bypass `@ai-sdk/google` enum limitations while mapping cleanly to backend tiers.
- **Claude 5.5 Support (`antigravity-claude-sonnet-5-5`, `antigravity-claude-opus-5-5`)**: Added pre-discovery pro-tier gating, automatic thinking detection via `supportsThinking` and catalog `displayName`, dynamic thinking budget mapping (`8192` / `16384` / `32768`), snake_case `thinkingConfig` payload transformation, and preserved tier model suffixes.
- **Gemini 3.8 Flash (`antigravity-gemini-3.8-flash`)**: Consolidated into a single model definition with selectable variants (`low`, `medium`, `high`) that rewrite backend IDs dynamically.
- **Orchestrator Model Filtering**: Excludes internal Orchestrator planner (`gemini-pro-orchestrator-g1-pro`) and worker (`gemini-flash-worker-agy`) models from the published V2 model catalog via `isChatModel`.

### Multi-Tier and Pro Quota Management

- **Argon Weekly Bucket Isolation**: Strictly isolates `gemini-argon` in its weekly quota bucket. Excludes the internal worker model `gemini-flash-worker-agy` (which is labeled `(Orchestrator)` in its display name but refills on a 5-hour window) from `gemini-argon`, routing it to `gemini-flash` to prevent 5-hour resets from overwriting weekly reset windows.
- **Two-Tier Pro Quota Parsing**: Accurately parses both 5-hour rolling windows and weekly reset allowances from Google's `retrieveUserQuotaSummary`.
- **Local Timezone Reset Formatting**: Displays quota reset times in the user's local timezone (e.g., `resets 20:07 (local time)` or `in 5d 20:07 (local time)`) rather than raw UTC timestamps.
- **Shared `gemini-flash` Quota Pool**: Aggregates Flash, Lite, Hydrogen, and worker models into a unified 5-hour quota group, preventing model-specific quota fragmentation.
- **Bounded Quota Sweep**: Parallelizes multi-account quota checks with concurrency controls and a time-bounded sweep budget.

### Storage Safety and Account Resilience

- **Storage Corruption Protection**: Utilizes atomic file replacement with proper lockfiles and graceful degradation when reading unreadable storage, preventing accidental account pool deletion.
- **Test Fixture Storage Isolation**: Completely mocks storage across all test suites, preventing test fixtures (e.g. `test@example.com`) from leaking into `~/.config/opencode/antigravity-accounts.json`.
- **License Benching**: Sequesters accounts lacking product licenses instead of consuming fail-fast retry budgets across all accounts.
- **System Prompt Fingerprint Neutralization**: Strips competing client instructions and conflicting prompt directives that trigger Google backend rejections.
- **Hub User-Agent Changelist**: Sends the official Google Antigravity Hub build changelist header in outgoing requests for upstream protocol compatibility.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
OPENCODE_BIN=/path/to/opencode npm run test:e2e:v2
```

The runtime test uses synthetic credentials. Authenticated model and menu checks require a logged-in Google account.

[V2 migration and verification](docs/OPENCODE-V2.md) · [Configuration](docs/CONFIGURATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

OpenCode 1.18.29+ remains supported through the legacy entrypoint; its account menu opens from `opencode auth login`.
