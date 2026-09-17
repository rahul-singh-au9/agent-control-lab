import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { type Env } from './index';
import { fixtures } from '../src/core/fixtures';
import { MAX_TRACE_BYTES, type Trace } from '../src/core/schema';

type TestPayload = {
  report: { id: string; trace: unknown };
  reports: unknown[];
  ok?: boolean;
  error?: string;
  requestId?: string;
};

const origin = 'https://lab.example';
let db: DatabaseSync;
let env: Env;
let limitSuccess = true;

function adapter(): D1Database {
  return {
    prepare(sql: string) {
      let args: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) {
          args = values;
          return statement;
        },
        first() {
          return Promise.resolve(db.prepare(sql).get(...args) ?? null);
        },
        all() {
          return Promise.resolve({ results: db.prepare(sql).all(...args) });
        },
        run() {
          const before = Number(db.prepare('SELECT total_changes() AS n').get()?.n);
          db.prepare(sql).run(...args);
          return Promise.resolve({
            meta: { changes: Number(db.prepare('SELECT total_changes() AS n').get()?.n) - before },
          });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_reports.sql', import.meta.url), 'utf8'));
  limitSuccess = true;
  env = {
    DB: adapter(),
    ASSETS: { fetch: () => Promise.resolve(new Response('asset')) } as unknown as Fetcher,
    WRITE_LIMITER: { limit: () => Promise.resolve({ success: limitSuccess }) },
  };
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

async function request(
  path: string,
  method = 'GET',
  cookie?: string,
  body?: unknown,
  overrides?: Record<string, string>,
) {
  return worker.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...overrides,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}
async function session(): Promise<string> {
  const response = await request('/api/session', 'POST', undefined, {});
  return response.headers.get('Set-Cookie')!.split(';')[0];
}
async function save(cookie: string) {
  return request('/api/reports', 'POST', cookie, { trace: fixtures[0].trace });
}

function sizedTrace(bytes: number): Trace {
  const trace = structuredClone(fixtures[0].trace);
  for (let index = 0; index < 9; index++) {
    trace.events.push({
      id: `padding-${index}`,
      seq: index + 4,
      timestamp: '2026-01-15T10:00:00Z',
      type: 'context',
      source: 'agent',
      content: '',
    });
  }
  let remaining = bytes - new TextEncoder().encode(JSON.stringify(trace)).byteLength;
  for (const event of trace.events.slice(3)) {
    if (event.type !== 'context') continue;
    const length = Math.min(8_000, remaining);
    event.content = 'x'.repeat(length);
    remaining -= length;
  }
  expect(remaining).toBe(0);
  expect(new TextEncoder().encode(JSON.stringify(trace)).byteLength).toBe(bytes);
  return trace;
}

describe('private report API', () => {
  it('uses secure HttpOnly same-site cookies and never returns the credential in JSON', async () => {
    const response = await request('/api/session', 'POST', undefined, {});
    const setCookie = response.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('__Host-acl_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(await response.json<TestPayload>()).toEqual({ retentionDays: 30, maxReports: 20 });
  });

  it('reuses a valid credential without changing the owner and only stores its digest', async () => {
    const cookie = await session();
    const token = cookie.split('=')[1];
    const saved = await save(cookie);
    expect(saved.status).toBe(201);
    for (const method of ['GET', 'POST']) {
      const renewed = await request(
        '/api/session',
        method,
        cookie,
        method === 'POST' ? {} : undefined,
      );
      expect(renewed.headers.get('Set-Cookie')?.split(';')[0]).toBe(cookie);
    }
    const rows = db.prepare('SELECT owner_id, trace FROM reports').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_id).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].owner_id).not.toBe(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('uses the separate local cookie without weakening the HTTPS credential', async () => {
    const response = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/session', {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:8787', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    const localCookie = response.headers.get('Set-Cookie')!;
    expect(localCookie).toMatch(/^acl_session=/);
    expect(localCookie).toContain('HttpOnly; SameSite=Strict; Max-Age=2592000');
    expect(localCookie).not.toContain('Secure');
    expect((await request('/api/session', 'GET', localCookie.split(';')[0])).status).toBe(401);
  });

  it.each([null, [], 'credential', { owner: 'another-owner' }])(
    'rejects nonempty or nonobject session creation input %j',
    async (body) => {
      const response = await request('/api/session', 'POST', undefined, body);
      expect(response.status).toBe(400);
      expect(response.headers.has('Set-Cookie')).toBe(false);
    },
  );

  it('bounds session creation bodies and rejects missing or malformed JSON', async () => {
    expect(
      (await request('/api/session', 'POST', undefined, { padding: 'x'.repeat(1_024) })).status,
    ).toBe(413);
    for (const body of [undefined, '{']) {
      const response = await worker.fetch(
        new Request(`${origin}/api/session`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body,
        }),
        env,
      );
      expect(response.status).toBe(400);
      expect(response.headers.has('Set-Cookie')).toBe(false);
    }
  });

  it('accepts a case-insensitive JSON media type with its charset parameter', async () => {
    const response = await request(
      '/api/session',
      'POST',
      undefined,
      {},
      { 'Content-Type': 'Application/JSON; charset=utf-8' },
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ['/api/health', 'POST', 'GET'],
    ['/api/health', 'DELETE', 'GET'],
    ['/api/session', 'DELETE', 'GET, POST'],
    ['/api/reports', 'DELETE', 'GET, POST'],
    ['/api/reports', 'PUT', 'GET, POST'],
    ['/api/reports', 'OPTIONS', 'GET, POST'],
    ['/api/reports/12345678-1234-4123-8123-123456789012', 'POST', 'GET, DELETE'],
  ])(
    'returns the allowed methods for %s %s before doing database or limiter work',
    async (path, method, allow) => {
      const database = vi.spyOn(env.DB, 'prepare');
      const limiter = vi.spyOn(env.WRITE_LIMITER, 'limit');
      const response = await request(path, method);
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe(allow);
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
      expect(database).not.toHaveBeenCalled();
      expect(limiter).not.toHaveBeenCalled();
    },
  );

  it.each([
    '/api/no-such-path',
    '/api/session/',
    '/api/reports/not-an-id',
    '/api/reports/12345678-1234-4123-8123-123456789012/extra',
    '/api/reports/%27OR%201%3D1',
  ])('rejects unsupported path %s without a session or database query', async (path) => {
    const database = vi.spyOn(env.DB, 'prepare');
    expect((await request(path)).status).toBe(404);
    expect(database).not.toHaveBeenCalled();
  });

  it('marks API successes and errors as noncacheable same-origin JSON and assigns separate request IDs', async () => {
    const success = await request('/api/health');
    const failure = await request('/api/reports');
    for (const response of [success, failure]) {
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
    expect(success.headers.get('X-Request-ID')).not.toBe(failure.headers.get('X-Request-ID'));
    expect((await failure.json<TestPayload>()).requestId).toBe(failure.headers.get('X-Request-ID'));
  });

  it('requires sessions, validates cookies, and refuses cross-origin changes', async () => {
    expect((await request('/api/reports')).status).toBe(401);
    expect((await request('/api/session', 'GET', '__Host-acl_session=short')).status).toBe(401);
    expect(
      (
        await request(
          '/api/session',
          'POST',
          undefined,
          {},
          { Origin: 'https://elsewhere.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request('/api/session', 'POST', undefined, {}, { 'Content-Type': 'text/plain' }))
        .status,
    ).toBe(415);
  });

  it.each([
    ['missing Origin', {}],
    [
      'cross-site fetch metadata despite a matching Origin',
      { Origin: origin, 'Sec-Fetch-Site': 'cross-site' },
    ],
  ])(
    'rejects report writes with %s without changing stored data',
    async (_description, extraHeaders) => {
      const cookie = await session();
      const { report } = await (await save(cookie)).json<TestPayload>();
      const headers = new Headers({ Cookie: cookie, 'Content-Type': 'application/json' });
      for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

      const create = await worker.fetch(
        new Request(`${origin}/api/reports`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ trace: fixtures[0].trace }),
        }),
        env,
      );
      const remove = await worker.fetch(
        new Request(`${origin}/api/reports/${report.id}`, {
          method: 'DELETE',
          headers,
        }),
        env,
      );

      expect(create.status).toBe(403);
      expect(remove.status).toBe(403);
      expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
      expect((await request(`/api/reports/${report.id}`, 'GET', cookie)).status).toBe(200);
    },
  );

  it('rejects ambiguous duplicate session cookies instead of selecting either owner', async () => {
    const alice = await session();
    const bob = await session();
    const { report } = await (await save(alice)).json<TestPayload>();

    for (const cookie of [`${alice}; ${bob}`, `${bob}; ${alice}`, `${alice}; ${alice}`]) {
      expect((await request('/api/session', 'GET', cookie)).status).toBe(401);
      expect((await request('/api/reports', 'GET', cookie)).status).toBe(401);
      expect((await request(`/api/reports/${report.id}`, 'GET', cookie)).status).toBe(401);
      expect((await request(`/api/reports/${report.id}`, 'DELETE', cookie)).status).toBe(401);
      expect((await save(cookie)).status).toBe(401);
    }

    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
    expect((await request(`/api/reports/${report.id}`, 'GET', alice)).status).toBe(200);
  });

  it('persists an exact validated trace, lists it, and isolates reads and deletes by owner', async () => {
    const alice = await session();
    const bob = await session();
    const response = await save(alice);
    expect(response.status).toBe(201);
    const { report } = await response.json<TestPayload>();
    expect(report.trace).toEqual(fixtures[0].trace);
    expect((await request(`/api/reports/${report.id}`, 'GET', bob)).status).toBe(404);
    expect((await request(`/api/reports/${report.id}`, 'DELETE', bob)).status).toBe(404);
    const list = await (await request('/api/reports', 'GET', alice)).json<TestPayload>();
    expect(list.reports).toHaveLength(1);
    expect((await request(`/api/reports/${report.id}`, 'GET', alice)).status).toBe(200);
    expect((await request(`/api/reports/${report.id}`, 'DELETE', alice)).status).toBe(200);
    expect((await request(`/api/reports/${report.id}`, 'GET', alice)).status).toBe(404);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(0);
  });

  it('rejects malformed data, oversized payloads, and unsupported paths without storing data', async () => {
    const cookie = await session();
    expect((await request('/api/reports', 'POST', cookie, { trace: { events: [] } })).status).toBe(
      400,
    );
    expect(
      (
        await request('/api/reports', 'POST', cookie, {
          trace: fixtures[0].trace,
          owner_id: 'someone',
        })
      ).status,
    ).toBe(400);
    expect(
      (await request('/api/reports', 'POST', cookie, { trace: 'x'.repeat(70_000) })).status,
    ).toBe(413);
    expect((await request('/api/reports/not-an-id', 'GET', cookie)).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
  });

  it('accepts exactly 64 KiB and rejects a trace one byte above the limit with 413', async () => {
    const cookie = await session();
    const atLimit = await request('/api/reports', 'POST', cookie, {
      trace: sizedTrace(MAX_TRACE_BYTES),
    });
    expect(atLimit.status).toBe(201);
    const overLimit = await request('/api/reports', 'POST', cookie, {
      trace: sizedTrace(MAX_TRACE_BYTES + 1),
    });
    expect(overLimit.status).toBe(413);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
  });

  it('enforces normalized trace bytes when compact numeric notation fits the request limit', async () => {
    const cookie = await session();
    const trace = sizedTrace(MAX_TRACE_BYTES - 13);
    trace.events[trace.events.length - 1].seq = 1e15;
    expect(new TextEncoder().encode(JSON.stringify(trace)).byteLength).toBe(MAX_TRACE_BYTES + 1);
    const body = JSON.stringify({ trace }).replace('"seq":1000000000000000', '"seq":1e15');
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(MAX_TRACE_BYTES);
    const response = await worker.fetch(
      new Request(`${origin}/api/reports`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body,
      }),
      env,
    );
    expect(response.status).toBe(413);
    expect((await response.json<TestPayload>()).error).toContain('64 KiB');
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
  });

  it('rejects bounded deeply nested input without reporting an infrastructure failure', async () => {
    const cookie = await session();
    const boundedBody = '{"trace":' + '['.repeat(12_000) + 'null' + ']'.repeat(12_000) + '}';
    expect(boundedBody.length).toBeLessThan(MAX_TRACE_BYTES);
    const response = await worker.fetch(
      new Request(`${origin}/api/reports`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: boundedBody,
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
  });

  it('keeps SQL-like text inert and rejects prototype-related fields', async () => {
    const cookie = await session();
    const trace = structuredClone(fixtures[0].trace);
    trace.title = "'); DROP TABLE reports; --";
    expect((await request('/api/reports', 'POST', cookie, { trace })).status).toBe(201);
    expect(db.prepare('SELECT title FROM reports').get()?.title).toBe(trace.title);
    const body = JSON.stringify({ trace }).replace(
      '"trace":{',
      '"trace":{"__proto__":{"polluted":true},',
    );
    const rejected = await worker.fetch(
      new Request(`${origin}/api/reports`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body,
      }),
      env,
    );
    expect(rejected.status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
  });

  it.each([false, true])(
    'rejects oversized multibyte streams without trusting Content-Length, including cancellation failure %s',
    async (cancelFails) => {
      const cookie = await session();
      const text = JSON.stringify({ trace: '界'.repeat(30_000) });
      const bytes = new TextEncoder().encode(text);
      expect(text.length).toBeLessThan(64 * 1024);
      expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
      let offset = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 4096, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
        cancel() {
          cancelled = true;
          if (cancelFails) throw new Error('transport cancellation failed');
        },
      });
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body,
        duplex: 'half',
      };
      const incoming = new Request(`${origin}/api/reports`, init);
      expect(incoming.headers.has('Content-Length')).toBe(false);

      const response = await worker.fetch(incoming, env);

      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(offset).toBeLessThan(bytes.length);
      expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
    },
  );

  it('rejects malformed UTF-8 rather than replacing corrupt bytes before validation', async () => {
    const cookie = await session();
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode('{"trace":"'),
      0xc3,
      0x28,
      ...encoder.encode('"}'),
    ]);
    const response = await worker.fetch(
      new Request(`${origin}/api/reports`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: bytes,
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect((await response.json<TestPayload>()).error).toContain('UTF-8');
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
  });

  it('caps each workspace atomically, including concurrent saves', async () => {
    const cookie = await session();
    const responses = await Promise.all(Array.from({ length: 25 }, () => save(cookie)));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(20);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(20);
  });

  it('admits only one concurrent owner at the global boundary and releases capacity on deletion', async () => {
    const now = Date.now();
    const trace = fixtures[0].trace;
    const insert = db.prepare(`INSERT INTO reports
      (id, owner_id, title, origin, created_at, expires_at, action_count, trace)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    for (let index = 0; index < 1999; index++) {
      insert.run(
        crypto.randomUUID(),
        `seed-owner-${Math.floor(index / 20)}`,
        trace.title,
        trace.origin,
        now,
        now + 30 * 86_400_000,
        1,
        JSON.stringify(trace),
      );
    }
    db.exec('COMMIT');
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1999);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(1999);

    const cookies = await Promise.all(Array.from({ length: 8 }, () => session()));
    const responses = await Promise.all(cookies.map((cookie) => save(cookie)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(7);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(2000);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(2000);
    expect(
      db.prepare('SELECT owner_id FROM reports GROUP BY owner_id HAVING COUNT(*) > 20').all(),
    ).toEqual([]);

    const winner = responses.findIndex((response) => response.status === 201);
    const loser = responses.findIndex((response) => response.status === 409);
    const { report } = await responses[winner].json<TestPayload>();
    const losingList = await (
      await request('/api/reports', 'GET', cookies[loser])
    ).json<TestPayload>();
    expect(losingList.reports).toHaveLength(0);
    expect((await request(`/api/reports/${report.id}`, 'DELETE', cookies[winner])).status).toBe(
      200,
    );
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(1999);
    expect((await save(cookies[loser])).status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(2000);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(2000);
  });

  it('stops access exactly at expiration before scheduled cleanup removes the row', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-17T10:00:00Z'));
    const cookie = await session();
    const { report } = await (await save(cookie)).json<TestPayload>();
    const row = db.prepare('SELECT expires_at FROM reports WHERE id = ?').get(report.id)!;
    const expiresAt = Number(row.expires_at);
    expect(expiresAt - Date.now()).toBe(30 * 86_400_000);
    clock.mockReturnValue(expiresAt - 1);
    expect((await request(`/api/reports/${report.id}`, 'GET', cookie)).status).toBe(200);
    const before = await (await request('/api/reports', 'GET', cookie)).json<TestPayload>();
    expect(before.reports).toHaveLength(1);

    clock.mockReturnValue(expiresAt);
    expect((await request(`/api/reports/${report.id}`, 'GET', cookie)).status).toBe(404);
    const list = await (await request('/api/reports', 'GET', cookie)).json<TestPayload>();
    expect(list.reports).toHaveLength(0);
    expect((await request(`/api/reports/${report.id}`, 'DELETE', cookie)).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.scheduled({} as ScheduledController, env);
    expect(logs).toHaveBeenCalledWith(
      JSON.stringify({ event: 'retention_cleanup_completed', databaseChanges: 2 }),
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(0);
  });

  it('reports an unhealthy database when the required capacity record is absent', async () => {
    expect((await request('/api/health')).status).toBe(200);
    db.exec('DELETE FROM capacity WHERE id = 1');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request('/api/health');

    expect(response.status).toBe(503);
    const body = await response.json<TestPayload>();
    expect(body.ok).not.toBe(true);
    expect(body.error).not.toContain('schema');
    expect(body.requestId).toBe(response.headers.get('X-Request-ID'));
  });

  it('fails safely when stored JSON is corrupt or no longer satisfies the trace schema', async () => {
    const cookie = await session();
    const { report } = await (await save(cookie)).json<TestPayload>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const damaged of [
      'private-corrupt-content',
      JSON.stringify({ privateDetail: 'sensitive-stored-data' }),
    ]) {
      db.prepare('UPDATE reports SET trace = ? WHERE id = ?').run(damaged, report.id);
      const response = await request(`/api/reports/${report.id}`, 'GET', cookie);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain('temporarily unavailable');
      expect(body).not.toContain('private');
      expect(body).not.toContain('sensitive');
    }
    expect(JSON.stringify(errors.mock.calls)).not.toContain('private');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('sensitive');
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
  });

  it('retains unexpired data and resumes cleanup safely after a database failure', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-17T10:00:00Z'));
    const cookie = await session();
    const expired = await (await save(cookie)).json<TestPayload>();
    clock.mockReturnValue(Date.now() + 10 * 86_400_000);
    const retained = await (await save(cookie)).json<TestPayload>();
    clock.mockReturnValue(Date.now() + 21 * 86_400_000);
    vi.spyOn(env.DB, 'prepare').mockImplementationOnce(() => {
      throw new Error('cleanup unavailable');
    });
    await expect(worker.scheduled({} as ScheduledController, env)).rejects.toThrow(
      'cleanup unavailable',
    );
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(2);
    await worker.scheduled({} as ScheduledController, env);
    await worker.scheduled({} as ScheduledController, env);
    expect(db.prepare('SELECT id FROM reports').all()).toEqual([{ id: retained.report.id }]);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(1);
    expect((await request(`/api/reports/${expired.report.id}`, 'GET', cookie)).status).toBe(404);
    expect((await request(`/api/reports/${retained.report.id}`, 'GET', cookie)).status).toBe(200);
  });

  it('forwards static assets without touching private storage', async () => {
    const database = vi.spyOn(env.DB, 'prepare');
    const limiter = vi.spyOn(env.WRITE_LIMITER, 'limit');
    const response = await request('/assets/application.js');
    expect(await response.text()).toBe('asset');
    expect(database).not.toHaveBeenCalled();
    expect(limiter).not.toHaveBeenCalled();
  });

  it('returns rate-limit retry guidance and fails closed when the limiter or database is unavailable', async () => {
    const cookie = await session();
    limitSuccess = false;
    const limited = await save(cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    limitSuccess = true;
    vi.spyOn(env.WRITE_LIMITER, 'limit').mockRejectedValueOnce(
      new Error('sensitive internal detail'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await save(cookie)).status).toBe(503);
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('secret connection detail');
    });
    const failure = await request('/api/reports', 'GET', cookie);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('secret');
    expect((await request('/api/health')).status).toBe(503);
  });

  it('does not create a session or save data when the required limiter binding is missing', async () => {
    const cookie = await session();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.WRITE_LIMITER = undefined as unknown as Env['WRITE_LIMITER'];
    const response = await request('/api/session', 'POST', undefined, {});
    expect(response.status).toBe(503);
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect((await save(cookie)).status).toBe(503);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(cookie.split('=')[1]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(fixtures[0].trace.title);
  });
});
