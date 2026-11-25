import type {
  SignatureStore,
  StreamingCallbacks,
  StreamingOptions,
  ThoughtBuffer,
} from './types';
import { processImageData } from '../../image-saver';
import { debugLogToFile } from '../../debug';

/** Cap debug snippets so a huge malformed payload cannot bloat the log file. */
const SSE_DEBUG_SNIPPET_MAX = 2000;

/** Log an SSE anomaly to the debug file: parse failures, upstream error
 * events, and truncated streams are invisible to the SDK wrapper otherwise. */
function logSseAnomaly(kind: string, json: string): void {
  debugLogToFile(`[SseTransform] ${kind} (${json.length} chars): ${json.slice(0, SSE_DEBUG_SNIPPET_MAX)}`);
}

/** Rewrite a Google error event as a schema-valid response whose text carries
 * the real cause; @ai-sdk/google's chunk schema strips unknown keys, so the
 * raw event would otherwise end the stream with an empty result. */
function synthesizeErrorResponse(errorPayload: unknown): unknown {
  const err = errorPayload as { code?: unknown; message?: unknown; status?: unknown };
  const status = typeof err?.status === 'string'
    ? err.status
    : err?.code !== undefined
      ? String(err.code)
      : 'UNKNOWN';
  const message = typeof err?.message === 'string'
    ? err.message
    : JSON.stringify(errorPayload).slice(0, SSE_DEBUG_SNIPPET_MAX);
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: `[Antigravity] Upstream Google error ${status}: ${message}` }],
        },
        // Without a finish reason the adapter sees a stream that simply stops
        // and the session retries with "unknown finish reason" instead of
        // showing the upstream message.
        finishReason: 'STOP',
        index: 0,
      },
    ],
  };
}

/**
 * Simple string hash for thinking deduplication.
 * Uses DJB2-like algorithm.
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i); /* hash * 33 + c */
  }
  return (hash >>> 0).toString(16);
}

export function createThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();
  return {
    get: (index: number) => buffer.get(index),
    set: (index: number, text: string) => buffer.set(index, text),
    clear: () => buffer.clear(),
  };
}

export function transformStreamingPayload(
  payload: string,
  transformThinkingParts?: (response: unknown) => unknown,
): string {
  return payload
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) {
        return line;
      }
      const json = line.slice(5).trim();
      if (!json) {
        return line;
      }
      try {
        const parsed = JSON.parse(json) as { response?: unknown };
        if (parsed.response !== undefined) {
          const transformed = transformThinkingParts
            ? transformThinkingParts(parsed.response)
            : parsed.response;
          return `data: ${JSON.stringify(transformed)}`;
        }
      } catch (_) {
        logSseAnomaly('unparseable SSE payload line', json);
      }
      return line;
    })
    .join('\n');
}

export function deduplicateThinkingText(
  response: unknown,
  sentBuffer: ThoughtBuffer,
  displayedThinkingHashes?: Set<string>,
): unknown {
  if (!response || typeof response !== 'object') return response;

  const resp = response as Record<string, unknown>;

  if (Array.isArray(resp.candidates)) {
    const newCandidates = resp.candidates.map((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return candidate;

      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return candidate;

      const newParts = content.parts.map((part: unknown) => {
        const p = part as Record<string, unknown>;
        
        // Handle image data - save to disk and return file path
        if (p.inlineData) {
          const inlineData = p.inlineData as Record<string, unknown>;
          const result = processImageData({
            mimeType: inlineData.mimeType as string | undefined,
            data: inlineData.data as string | undefined,
          });
          if (result) {
            return { text: result };
          }
        }
        
        if (p.thought === true || p.type === 'thinking') {
          const fullText = (p.text || p.thinking || '') as string;
          
          if (displayedThinkingHashes) {
            const hash = hashString(fullText);
            if (displayedThinkingHashes.has(hash)) {
              sentBuffer.set(index, fullText);
              return null;
            }
            displayedThinkingHashes.add(hash);
          }

          const sentText = sentBuffer.get(index) ?? '';

          if (fullText.startsWith(sentText)) {
            const delta = fullText.slice(sentText.length);
            sentBuffer.set(index, fullText);

            if (delta) {
              return { ...p, text: delta, thinking: delta };
            }
            return null;
          }

          sentBuffer.set(index, fullText);
          return part;
        }
        return part;
      });

      const filteredParts = newParts.filter((p) => p !== null);

      return {
        ...cand,
        content: { ...content, parts: filteredParts },
      };
    });

    return { ...resp, candidates: newCandidates };
  }

  if (Array.isArray(resp.content)) {
    let thinkingIndex = 0;
    const newContent = resp.content.map((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === 'thinking') {
        const fullText = (b.thinking || b.text || '') as string;
        
        if (displayedThinkingHashes) {
          const hash = hashString(fullText);
          if (displayedThinkingHashes.has(hash)) {
            sentBuffer.set(thinkingIndex, fullText);
            thinkingIndex++;
            return null;
          }
          displayedThinkingHashes.add(hash);
        }

        const sentText = sentBuffer.get(thinkingIndex) ?? '';

        if (fullText.startsWith(sentText)) {
          const delta = fullText.slice(sentText.length);
          sentBuffer.set(thinkingIndex, fullText);
          thinkingIndex++;

          if (delta) {
            return { ...b, thinking: delta, text: delta };
          }
          return null;
        }

        sentBuffer.set(thinkingIndex, fullText);
        thinkingIndex++;
        return block;
      }
      return block;
    });

    const filteredContent = newContent.filter((b) => b !== null);
    return { ...resp, content: filteredContent };
  }

  return response;
}

export function transformSseLine(
  line: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  sentThinkingBuffer: ThoughtBuffer,
  callbacks: StreamingCallbacks,
  options: StreamingOptions,
  debugState: { injected: boolean },
): string {
  if (!line.startsWith('data:')) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }

  try {
    const parsed = JSON.parse(json) as { response?: unknown };
    if (parsed.response !== undefined) {
      if (options.cacheSignatures && options.signatureSessionKey) {
        cacheThinkingSignaturesFromResponse(
          parsed.response,
          options.signatureSessionKey,
          signatureStore,
          thoughtBuffer,
          callbacks.onCacheSignature,
        );
      }

      let response: unknown = deduplicateThinkingText(
        parsed.response,
        sentThinkingBuffer,
        options.displayedThinkingHashes
      );

      if (options.debugText && callbacks.onInjectDebug && !debugState.injected) {
        response = callbacks.onInjectDebug(response, options.debugText);
        debugState.injected = true;
      }
      // Note: onInjectSyntheticThinking removed - keep_thinking now uses debugText path

      const transformed = callbacks.transformThinkingParts
        ? callbacks.transformThinkingParts(response)
        : response;
      return `data: ${JSON.stringify(transformed)}`;
    }

    // A Google mid-stream error event parses but carries no response key. The
    // SDK schema strips unknown keys, so the error message would be dropped
    // silently; rewrite it as a top-level Gemini response chunk so @ai-sdk/google
    // reads both the error text and the STOP finishReason.
    const errorPayload = (parsed as { error?: unknown }).error;
    if (errorPayload !== undefined) {
      logSseAnomaly('upstream error event', json);
      return `data: ${JSON.stringify(synthesizeErrorResponse(errorPayload))}`;
    }
  } catch (_) {
    logSseAnomaly('unparseable SSE line', json);
  }
  return line;
}

export function cacheThinkingSignaturesFromResponse(
  response: unknown,
  signatureSessionKey: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void,
): void {
  if (!response || typeof response !== 'object') return;

  const resp = response as Record<string, unknown>;

  if (Array.isArray(resp.candidates)) {
    resp.candidates.forEach((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return;
      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return;

      content.parts.forEach((part: unknown) => {
        const p = part as Record<string, unknown>;
        if (p.thought === true || p.type === 'thinking') {
          const text = (p.text || p.thinking || '') as string;
          if (text) {
            const current = thoughtBuffer.get(index) ?? '';
            thoughtBuffer.set(index, current + text);
          }
        }

        if (p.thoughtSignature) {
          const fullText = thoughtBuffer.get(index) ?? '';
          if (fullText) {
            const signature = p.thoughtSignature as string;
            onCacheSignature?.(signatureSessionKey, fullText, signature);
            signatureStore.set(signatureSessionKey, { text: fullText, signature });
          }
        }
      });
    });
  }

  if (Array.isArray(resp.content)) {
    // Use thoughtBuffer to accumulate thinking text across SSE events
    // Claude streams thinking content and signature in separate events
    const CLAUDE_BUFFER_KEY = 0; // Use index 0 for Claude's single-stream content
    resp.content.forEach((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === 'thinking') {
        const text = (b.thinking || b.text || '') as string;
        if (text) {
          const current = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? '';
          thoughtBuffer.set(CLAUDE_BUFFER_KEY, current + text);
        }
      }
      if (b?.signature) {
        const fullText = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? '';
        if (fullText) {
          const signature = b.signature as string;
          onCacheSignature?.(signatureSessionKey, fullText, signature);
          signatureStore.set(signatureSessionKey, { text: fullText, signature });
        }
      }
    });
  }
}

function hasMeaningfulCandidateParts(parts: unknown): boolean {
  if (!Array.isArray(parts)) {
    return false;
  }
  return parts.some((part) => {
    if (!part || typeof part !== 'object') {
      return false;
    }
    const candidatePart = part as Record<string, unknown>;
    if (typeof candidatePart.text === 'string' && candidatePart.text.length > 0) {
      return true;
    }
    return Boolean(
      candidatePart.functionCall ||
      candidatePart.functionResponse ||
      candidatePart.inlineData ||
      candidatePart.fileData ||
      candidatePart.executableCode ||
      candidatePart.codeExecutionResult,
    );
  });
}

function isMeaningfulRawSseLine(line: string): boolean {
  if (!line.startsWith('data:')) {
    return false;
  }
  const json = line.slice(5).trim();
  if (!json || json === '[DONE]') {
    return false;
  }
  try {
    const parsed = JSON.parse(json) as {
      error?: unknown;
      response?: unknown;
      candidates?: unknown;
    };
    if (parsed.error !== undefined) {
      return true;
    }
    const payload = (
      parsed.response && typeof parsed.response === 'object'
        ? parsed.response
        : parsed
    ) as {
      candidates?: Array<{
        finishReason?: unknown;
        content?: { parts?: unknown };
      }>;
    };
    if (Array.isArray(payload.candidates)) {
      for (const candidate of payload.candidates) {
        if (hasMeaningfulCandidateParts(candidate?.content?.parts)) {
          return true;
        }
        // Non-STOP terminal reasons (SAFETY, MAX_TOKENS, RECITATION, etc.)
        // carry real termination semantics for the SDK and should stream through.
        if (
          typeof candidate?.finishReason === 'string' &&
          candidate.finishReason.length > 0 &&
          candidate.finishReason !== 'STOP'
        ) {
          return true;
        }
      }
    }
  } catch {
    // Wait for complete/valid JSON or EOF
  }
  return false;
}

export interface StreamingEmptyProbeResult {
  empty: boolean;
  response: Response;
}

/**
 * Peeks at an HTTP 200 SSE stream only until the first meaningful candidate
 * chunk (or upstream error / non-STOP finishReason) arrives, then immediately
 * hands back a pass-through Response that replays the buffered prefix and
 * streams all remaining chunks in real time. If the upstream closes the stream
 * before emitting any meaningful content (e.g. usageMetadata-only or empty
 * text/STOP chunks), resolves `{ empty: true }` so the caller can retry before
 * any synthetic STOP chunk reaches the AI SDK.
 */
export async function probeStreamingResponseForEmpty(
  response: Response,
): Promise<StreamingEmptyProbeResult> {
  if (!response.body) {
    return { empty: true, response };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks: Uint8Array[] = [];
  let lineBuffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        lineBuffer += decoder.decode();
        if (lineBuffer && isMeaningfulRawSseLine(lineBuffer)) {
          break;
        }
        return { empty: true, response };
      }

      if (value && value.byteLength > 0) {
        bufferedChunks.push(value);
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        let meaningful = false;
        for (const line of lines) {
          if (isMeaningfulRawSseLine(line)) {
            meaningful = true;
            break;
          }
        }
        if (meaningful) {
          break;
        }
      }
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  }

  let prefixIndex = 0;
  const passthrough = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < bufferedChunks.length) {
        const chunk = bufferedChunks[prefixIndex++];
        if (prefixIndex >= bufferedChunks.length) {
          bufferedChunks.length = 0;
        }
        if (chunk) {
          controller.enqueue(chunk);
        }
        return;
      }

      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      bufferedChunks.length = 0;
      return reader.cancel(reason);
    },
  });

  return {
    empty: false,
    response: new Response(passthrough, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    }),
  };
}

export function createStreamingTransformer(
  signatureStore: SignatureStore,
  callbacks: StreamingCallbacks,
  options: StreamingOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const thoughtBuffer = createThoughtBuffer();
  const sentThinkingBuffer = createThoughtBuffer();
  const debugState = { injected: false };
  let hasSeenUsageMetadata = false;
  let hasSeenFinishReason = false;
  let hasSeenCandidateContent = false;

  const inspectTransformedLine = (line: string): void => {
    if (!line.startsWith('data:')) {
      return;
    }
    const json = line.slice(5).trim();
    if (!json || json === '[DONE]') {
      return;
    }
    if (!json.includes('"finishReason"') && !json.includes('"usageMetadata"') && !json.includes('"candidates"')) {
      return;
    }
    try {
      const parsed = JSON.parse(json) as {
        usageMetadata?: unknown;
        candidates?: Array<{
          finishReason?: unknown;
          content?: { parts?: unknown[] };
        }>;
      };
      if (parsed.usageMetadata != null) {
        hasSeenUsageMetadata = true;
      }
      if (Array.isArray(parsed.candidates)) {
        for (const candidate of parsed.candidates) {
          if (typeof candidate?.finishReason === 'string' && candidate.finishReason.length > 0) {
            hasSeenFinishReason = true;
          }
          if (hasMeaningfulCandidateParts(candidate?.content?.parts)) {
            hasSeenCandidateContent = true;
          }
        }
      }
    } catch (error) {
      logSseAnomaly(`inspectTransformedLine parse error: ${describeStreamAbortReason(error)}`, json);
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const transformedLine = transformSseLine(
          line,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          options,
          debugState,
        );
        inspectTransformedLine(transformedLine);
        controller.enqueue(encoder.encode(transformedLine + '\n'));
      }
    },
    flush(controller) {
      buffer += decoder.decode();

      if (buffer) {
        const transformedLine = transformSseLine(
          buffer,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          options,
          debugState,
        );
        inspectTransformedLine(transformedLine);
        controller.enqueue(encoder.encode(transformedLine));
      }

      // A complete Google stream ends with a candidate finishReason and usageMetadata.
      // When an HTTP 200 SSE stream closes early without them, @ai-sdk/google falls
      // back to finishReason "other", which OpenCode rejects as "unknown finish reason".
      if (!hasSeenFinishReason) {
        debugLogToFile(
          hasSeenUsageMetadata
            ? '[SseTransform] stream ended without finishReason; emitting synthetic STOP chunk'
            : '[SseTransform] stream ended without usageMetadata or finishReason; upstream response was likely truncated mid-stream',
        );
        const closingChunk: Record<string, unknown> = {
          candidates: [
            {
              content: {
                role: 'model',
                parts: hasSeenCandidateContent
                  ? []
                  : [{ text: '[Antigravity] Upstream stream ended without emitting any content or finish reason.' }],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        };
        if (!hasSeenUsageMetadata) {
          closingChunk.usageMetadata = {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0,
          };
        }
        controller.enqueue(encoder.encode(`\ndata: ${JSON.stringify(closingChunk)}\n\n`));
      } else if (!hasSeenUsageMetadata) {
        debugLogToFile('[SseTransform] stream ended without usageMetadata; upstream response was likely truncated mid-stream');
        const syntheticUsage = {
          usageMetadata: {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0,
          },
        };
        controller.enqueue(encoder.encode(`\ndata: ${JSON.stringify(syntheticUsage)}\n\n`));
      }
    },
  });
}

/** Human-readable reason for a stream abort/cancel, for the debug file. */
export function describeStreamAbortReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message || reason.name;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  try {
    return String(reason);
  } catch (_) {
    return 'unknown reason';
  }
}

/** Wrap the upstream body so a mid-stream read failure is logged with its
 * real reason before the SDK re-wraps it as the generic "Failed to process
 * successful response" error. The runtime never invokes a transformer's
 * abort handler (verified on Node), so the logging lives on the source-side
 * readable: pull-based, one upstream read per consumer pull. */
export function wrapBodyWithAbortLogging(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        debugLogToFile(`[SseTransform] stream aborted: ${describeStreamAbortReason(error).slice(0, SSE_DEBUG_SNIPPET_MAX)}`);
        controller.error(error);
      }
    },
    cancel(reason) {
      debugLogToFile(`[SseTransform] stream cancelled: ${describeStreamAbortReason(reason).slice(0, SSE_DEBUG_SNIPPET_MAX)}`);
      return reader.cancel(reason);
    },
  });
}
