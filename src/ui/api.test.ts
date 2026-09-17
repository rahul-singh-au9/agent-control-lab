import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ensureSession } from './api';

const sessionInfo = { retentionDays: 30, maxReports: 20 };

function response(body: unknown = sessionInfo, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('anonymous session initialization', () => {
  it('shares an in-flight lookup and rechecks the browser credential on a later call', async () => {
    const lookup = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(lookup.promise).mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchMock);

    const startup = ensureSession();
    const save = ensureSession();
    const refresh = ensureSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/session');
    expect(fetchMock.mock.calls[0][1].method ?? 'GET').toBe('GET');

    lookup.resolve(response());
    expect(await Promise.all([startup, save, refresh])).toEqual([sessionInfo, sessionInfo, sessionInfo]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await ensureSession()).toEqual(sessionInfo);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('creates only one credential after a shared 401, including callers arriving during creation', async () => {
    const lookup = deferred<Response>();
    const creation = deferred<Response>();
    const creationStarted = deferred<void>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(lookup.promise)
      .mockImplementationOnce(() => { creationStarted.resolve(); return creation.promise; });
    vi.stubGlobal('fetch', fetchMock);

    const startup = ensureSession();
    const save = ensureSession();
    lookup.resolve(response({ error: 'Create a browser workspace first.' }, 401));
    await creationStarted.promise;
    const lateCaller = ensureSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/session');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin' });
    creation.resolve(response());

    expect(await Promise.all([startup, save, lateCaller])).toEqual([sessionInfo, sessionInfo, sessionInfo]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases a failed shared lookup so a later attempt can recover without creating an extra session', async () => {
    const lookup = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(lookup.promise).mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchMock);

    const failures = Promise.allSettled([ensureSession(), ensureSession()]);
    lookup.reject(new TypeError('Network unavailable'));
    const outcomes = await failures;

    expect(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason instanceof ApiError)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ensureSession()).toEqual(sessionInfo);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => (init.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('releases a failed creation so recovery can perform one new lookup and creation', async () => {
    const creation = deferred<Response>();
    const creationStarted = deferred<void>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: 'Session missing' }, 401))
      .mockImplementationOnce(() => { creationStarted.resolve(); return creation.promise; })
      .mockResolvedValueOnce(response({ error: 'Session still missing' }, 401))
      .mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetchMock);

    const failures = Promise.allSettled([ensureSession(), ensureSession()]);
    await creationStarted.promise;
    creation.resolve(response({ error: 'Storage temporarily unavailable' }, 503));
    const outcomes = await failures;
    expect(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason instanceof ApiError && outcome.reason.status === 503)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(await ensureSession()).toEqual(sessionInfo);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([, init]) => init.method ?? 'GET')).toEqual(['GET', 'POST', 'GET', 'POST']);
  });
});
