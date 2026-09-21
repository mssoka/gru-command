import { readFileSync, statSync } from 'node:fs';

const MAX_SESSION_BYTES = 32 * 1024 * 1024;

function contentText(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? [text] : [];
    }
    return [];
  });
}

/** Extract assistant-authored text only; prompt echoes and tool payloads never qualify. */
export function finalAssistantText(sessionFile: string): string {
  const size = statSync(sessionFile).size;
  if (size > MAX_SESSION_BYTES) throw new Error(`review session exceeds ${MAX_SESSION_BYTES} bytes`);
  const bytes = readFileSync(sessionFile);
  if (bytes.byteLength > MAX_SESSION_BYTES || bytes.byteLength !== size) {
    throw new Error('review session changed while bounded bytes were read');
  }
  let final: { readonly text: string; readonly stopReason?: string } | null = null;
  let claudeResult: { readonly isError: boolean; readonly detail: string } | null = null;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof frame !== 'object' || frame === null) continue;
    const record = frame as Record<string, unknown>;
    if (record.type === 'result' && typeof record.is_error === 'boolean') {
      claudeResult = {
        isError: record.is_error,
        detail: typeof record.result === 'string'
          ? record.result
          : typeof record.subtype === 'string' ? record.subtype : 'unknown result',
      };
      continue;
    }
    if (record.role === 'assistant' && typeof record.text === 'string') {
      final = {
        text: record.text,
        ...(typeof record.stopReason === 'string' ? { stopReason: record.stopReason } : {}),
      };
    }
    const message = record.message;
    if (typeof message !== 'object' || message === null || (message as { role?: unknown }).role !== 'assistant') continue;
    const assistant = message as { content?: unknown; stopReason?: unknown };
    const text = contentText(assistant.content).join('');
    // A trailing tool-only or empty assistant frame must not clobber the
    // last substantive assistant text.
    if (text.trim() === '') continue;
    final = {
      text,
      ...(typeof assistant.stopReason === 'string' ? { stopReason: assistant.stopReason } : {}),
    };
  }
  if (final === null || final.text.trim() === '') throw new Error('review session produced no assistant JSON output');
  if (claudeResult?.isError === true) {
    throw new Error(`review session did not complete successfully (Claude result: ${claudeResult.detail})`);
  }
  if (final.stopReason !== undefined && final.stopReason !== 'stop') {
    throw new Error(`review session did not complete successfully (stop reason ${final.stopReason})`);
  }
  if (final.stopReason === undefined && claudeResult?.isError !== false) {
    throw new Error('review session has assistant output but no successful terminal completion frame');
  }
  return final.text.trim();
}
