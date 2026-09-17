import { parseTrace, parseTraceText, type Trace } from '../core/schema';

export const MAX_BUNDLE_BYTES = 1024 * 1024;

export function decodeImportBytes(bytes: ArrayBuffer): string {
  if (bytes.byteLength > MAX_BUNDLE_BYTES)
    throw new Error('File exceeds 1 MiB. Raw traces must be within 64 KiB and 200 events.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      'This file is not valid UTF-8. Save the JSON using UTF-8 encoding and select it again.',
    );
  }
}

export async function traceDigest(trace: Trace): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(parseTrace(trace))),
  );
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function parseImport(text: string): Promise<Trace> {
  if (new TextEncoder().encode(text).byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(
      'This file is too large. Use a trace up to 64 KiB or an exported bundle up to 1 MiB.',
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This is not valid JSON. Check the formatting and try again.');
  }
  if (data === null || typeof data !== 'object' || !('trace' in data)) return parseTraceText(text);
  if (
    !('format' in data) ||
    data.format !== 'agent-control-lab' ||
    !('schemaVersion' in data) ||
    data.schemaVersion !== 1
  ) {
    throw new Error(
      'Unsupported report bundle. Import an Agent Control Lab version 1 export or a raw trace.',
    );
  }
  const next = parseTrace(data.trace);
  if ('traceDigest' in data || 'digestAlgorithm' in data) {
    if (
      !('digestAlgorithm' in data) ||
      data.digestAlgorithm !== 'SHA-256' ||
      !('traceDigest' in data) ||
      typeof data.traceDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.traceDigest)
    ) {
      throw new Error(
        'The export digest must use SHA-256 and contain 64 lowercase hexadecimal characters.',
      );
    }
    if (data.traceDigest !== (await traceDigest(next))) {
      throw new Error(
        'The export digest does not match its trace. The data may have changed; export it again from the original source.',
      );
    }
  }
  return next;
}
