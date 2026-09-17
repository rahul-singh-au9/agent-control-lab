import { describe, expect, it } from 'vitest';
import { fixtures } from '../core/fixtures';
import { evaluateTrace } from '../core/evaluate';
import { MAX_BUNDLE_BYTES, decodeImportBytes, parseImport, traceDigest } from './bundle';

const trace = fixtures[0].trace;
const envelope = { format: 'agent-control-lab', schemaVersion: 1, trace };

describe('file decoding', () => {
  it('preserves Unicode and accepts a UTF-8 byte order mark', () => {
    const text = '{"title":"नमस्ते · 🙂"}';
    expect(decodeImportBytes(new TextEncoder().encode(text).buffer)).toBe(text);
    expect(decodeImportBytes(new TextEncoder().encode('\ufeff' + text).buffer)).toBe(text);
  });

  it.each([[0xff], [0xc3], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0x80]])(
    'rejects malformed UTF-8 without replacement characters: %j',
    (...bytes) => {
      expect(() => decodeImportBytes(new Uint8Array(bytes).buffer)).toThrow('not valid UTF-8');
    },
  );

  it('checks the original byte size before decoding', () => {
    expect(() => decodeImportBytes(new ArrayBuffer(MAX_BUNDLE_BYTES + 1))).toThrow(
      'File exceeds 1 MiB',
    );
  });
});

describe('local trace and report imports', () => {
  it('imports a raw trace and a versioned bundle without changing policy decisions', async () => {
    const raw = await parseImport(JSON.stringify(trace));
    const bundled = await parseImport(
      JSON.stringify({
        ...envelope,
        traceDigest: await traceDigest(trace),
        digestAlgorithm: 'SHA-256',
        evaluation: { untrusted: true },
      }),
    );
    expect(raw).toEqual(trace);
    expect(bundled).toEqual(raw);
    expect(evaluateTrace(bundled)).toEqual(evaluateTrace(raw));
  });

  it('supports a versioned bundle without a digest and never trusts included evaluation', async () => {
    expect(
      await parseImport(
        JSON.stringify({ ...envelope, evaluation: { policies: [{ decision: 'allow' }] } }),
      ),
    ).toEqual(trace);
  });

  it.each([{ ...envelope, format: 'other-product' }, { ...envelope, schemaVersion: 2 }, { trace }])(
    'rejects unsupported bundle metadata',
    async (value) => {
      await expect(parseImport(JSON.stringify(value))).rejects.toThrow('Unsupported report bundle');
    },
  );

  it.each([
    { traceDigest: 'a'.repeat(64) },
    { digestAlgorithm: 'SHA-256' },
    { digestAlgorithm: 'SHA-1', traceDigest: 'a'.repeat(64) },
    { digestAlgorithm: 'SHA-256', traceDigest: 'A'.repeat(64) },
    { digestAlgorithm: 'SHA-256', traceDigest: 5 },
  ])('rejects incomplete or unsupported digest metadata', async (value) => {
    await expect(parseImport(JSON.stringify({ ...envelope, ...value }))).rejects.toThrow(
      'digest must use SHA-256',
    );
  });

  it('rejects a trace changed after export', async () => {
    const bundle = {
      ...envelope,
      trace: { ...trace, title: 'Altered title' },
      traceDigest: await traceDigest(trace),
      digestAlgorithm: 'SHA-256',
    };
    await expect(parseImport(JSON.stringify(bundle))).rejects.toThrow('digest does not match');
  });

  it('normalizes object key ordering before computing the digest', async () => {
    const reversed = Object.fromEntries(Object.entries(trace).reverse());
    const imported = await parseImport(
      JSON.stringify({
        ...envelope,
        trace: reversed,
        traceDigest: await traceDigest(trace),
        digestAlgorithm: 'SHA-256',
      }),
    );
    expect(imported).toEqual(trace);
  });

  it('applies byte limits to raw whitespace and to the whole bundle', async () => {
    await expect(parseImport(JSON.stringify(trace) + ' '.repeat(65536))).rejects.toThrow('64 KiB');
    await expect(
      parseImport(JSON.stringify({ ...envelope, extra: '🙂'.repeat(MAX_BUNDLE_BYTES / 4) })),
    ).rejects.toThrow('too large');
  });

  it('rejects malformed JSON and invalid embedded traces', async () => {
    await expect(parseImport('{')).rejects.toThrow('not valid JSON');
    await expect(
      parseImport(JSON.stringify({ ...envelope, trace: { ...trace, schemaVersion: 2 } })),
    ).rejects.toThrow('schemaVersion');
  });
});
