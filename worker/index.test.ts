import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { type Env } from './index';
import { fixtures } from '../src/core/fixtures';

const origin = 'https://lab.example';
let db: DatabaseSync;
let env: Env;
let limitSuccess = true;

function adapter(): D1Database {
  return {
    prepare(sql: string) {
      let args: (string | number | null)[] = [];
      const statement = {
        bind(...values: (string | number | null)[]) { args = values; return statement; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_reports.sql', import.meta.url), 'utf8'));
  limitSuccess = true;
  env = { DB: adapter(), ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    WRITE_LIMITER: { limit: async () => ({ success: limitSuccess }) } };
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

async function request(path: string, method = 'GET', cookie?: string, body?: unknown, overrides?: Record<string,string>) {
  return worker.fetch(new Request(`${origin}${path}`, { method, headers: {
    Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...overrides,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
}
async function session(): Promise<string> {
  const response = await request('/api/session', 'POST', undefined, {});
  return response.headers.get('Set-Cookie')!.split(';')[0];
}
async function save(cookie: string) {
  return request('/api/reports', 'POST', cookie, { trace: fixtures[0].trace });
}

describe('private report API', () => {
  it('uses secure HttpOnly same-site cookies and never returns the credential in JSON', async () => {
    const response = await request('/api/session', 'POST', undefined, {});
    const setCookie = response.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('__Host-acl_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(await response.json()).toEqual({ retentionDays: 30, maxReports: 20 });
  });

  it('requires sessions, validates cookies, and refuses cross-origin changes', async () => {
    expect((await request('/api/reports')).status).toBe(401);
    expect((await request('/api/session', 'GET', '__Host-acl_session=short')).status).toBe(401);
    expect((await request('/api/session', 'POST', undefined, {}, { Origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await request('/api/session', 'POST', undefined, {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
  });

  it.each([
    ['missing Origin', {}],
    ['cross-site fetch metadata despite a matching Origin', { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }],
  ])('rejects report writes with %s without changing stored data', async (_description, extraHeaders) => {
    const cookie = await session();
    const { report } = await (await save(cookie)).json() as { report: { id: string } };
    const headers = new Headers({ Cookie: cookie, 'Content-Type': 'application/json' });
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

    const create = await worker.fetch(new Request(`${origin}/api/reports`, {
      method: 'POST', headers, body: JSON.stringify({ trace: fixtures[0].trace }),
    }), env);
    const remove = await worker.fetch(new Request(`${origin}/api/reports/${report.id}`, {
      method: 'DELETE', headers,
    }), env);

    expect(create.status).toBe(403);
    expect(remove.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
    expect((await request(`/api/reports/${report.id}`, 'GET', cookie)).status).toBe(200);
  });

  it('rejects ambiguous duplicate session cookies instead of selecting either owner', async () => {
    const alice = await session();
    const bob = await session();
    const { report } = await (await save(alice)).json() as { report: { id: string } };

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
    const { report } = await response.json() as { report: { id:string; trace:unknown } };
    expect(report.trace).toEqual(fixtures[0].trace);
    expect((await request(`/api/reports/${report.id}`, 'GET', bob)).status).toBe(404);
    expect((await request(`/api/reports/${report.id}`, 'DELETE', bob)).status).toBe(404);
    const list = await (await request('/api/reports', 'GET', alice)).json() as {reports:unknown[]};
    expect(list.reports).toHaveLength(1);
    expect((await request(`/api/reports/${report.id}`, 'GET', alice)).status).toBe(200);
    expect((await request(`/api/reports/${report.id}`, 'DELETE', alice)).status).toBe(200);
    expect((await request(`/api/reports/${report.id}`, 'GET', alice)).status).toBe(404);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(0);
  });

  it('rejects malformed data, oversized payloads, and unsupported paths without storing data', async () => {
    const cookie = await session();
    expect((await request('/api/reports', 'POST', cookie, {trace:{events:[]}})).status).toBe(400);
    expect((await request('/api/reports', 'POST', cookie, {trace:fixtures[0].trace, owner_id:'someone'})).status).toBe(400);
    expect((await request('/api/reports', 'POST', cookie, {trace:'x'.repeat(70_000)})).status).toBe(413);
    expect((await request('/api/reports/not-an-id', 'GET', cookie)).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
  });

  it('cancels an oversized multibyte body stream without relying on Content-Length', async () => {
    const cookie = await session();
    const text = JSON.stringify({ trace: '界'.repeat(30_000) });
    const bytes = new TextEncoder().encode(text);
    expect(text.length).toBeLessThan(64 * 1024);
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
    let offset = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        const end = Math.min(offset + 4096, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel() { cancelled = true; },
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
  });

  it('rejects malformed UTF-8 rather than replacing corrupt bytes before validation', async () => {
    const cookie = await session();
    const encoder = new TextEncoder();
    const bytes = new Uint8Array([
      ...encoder.encode('{"trace":"'),
      0xc3, 0x28,
      ...encoder.encode('"}'),
    ]);
    const response = await worker.fetch(new Request(`${origin}/api/reports`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: bytes,
    }), env);

    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('UTF-8');
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
  });

  it('caps each workspace atomically, including concurrent saves', async () => {
    const cookie = await session();
    const responses = await Promise.all(Array.from({length:25}, () => save(cookie)));
    expect(responses.filter(r => r.status === 201)).toHaveLength(20);
    expect(responses.filter(r => r.status === 409)).toHaveLength(5);
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
      insert.run(crypto.randomUUID(), `seed-owner-${Math.floor(index / 20)}`, trace.title,
        trace.origin, now, now + 30 * 86_400_000, 1, JSON.stringify(trace));
    }
    db.exec('COMMIT');
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1999);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(1999);

    const cookies = await Promise.all(Array.from({ length: 8 }, () => session()));
    const responses = await Promise.all(cookies.map(cookie => save(cookie)));
    expect(responses.filter(response => response.status === 201)).toHaveLength(1);
    expect(responses.filter(response => response.status === 409)).toHaveLength(7);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(2000);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(2000);
    expect(db.prepare('SELECT owner_id FROM reports GROUP BY owner_id HAVING COUNT(*) > 20').all()).toEqual([]);

    const winner = responses.findIndex(response => response.status === 201);
    const loser = responses.findIndex(response => response.status === 409);
    const { report } = await responses[winner].json() as { report: { id: string } };
    const losingList = await (await request('/api/reports', 'GET', cookies[loser])).json() as { reports: unknown[] };
    expect(losingList.reports).toHaveLength(0);
    expect((await request(`/api/reports/${report.id}`, 'DELETE', cookies[winner])).status).toBe(200);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(1999);
    expect((await save(cookies[loser])).status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(2000);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(2000);
  });

  it('stops access exactly at expiration before scheduled cleanup removes the row', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-17T10:00:00Z'));
    const cookie = await session();
    const {report} = await (await save(cookie)).json() as {report:{id:string}};
    const row = db.prepare('SELECT expires_at FROM reports WHERE id = ?').get(report.id)!;
    const expiresAt = Number(row.expires_at);
    expect(expiresAt - Date.now()).toBe(30 * 86_400_000);
    clock.mockReturnValue(expiresAt - 1);
    expect((await request(`/api/reports/${report.id}`, 'GET', cookie)).status).toBe(200);
    const before = await (await request('/api/reports', 'GET', cookie)).json() as { reports: unknown[] };
    expect(before.reports).toHaveLength(1);

    clock.mockReturnValue(expiresAt);
    expect((await request(`/api/reports/${report.id}`, 'GET', cookie)).status).toBe(404);
    const list = await (await request('/api/reports', 'GET', cookie)).json() as {reports:unknown[]};
    expect(list.reports).toHaveLength(0);
    expect((await request(`/api/reports/${report.id}`, 'DELETE', cookie)).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(1);
    await worker.scheduled({} as ScheduledController, env);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reports').get()?.n).toBe(0);
    expect(db.prepare('SELECT report_count FROM capacity').get()?.report_count).toBe(0);
  });

  it('reports an unhealthy database when the required capacity record is absent', async () => {
    expect((await request('/api/health')).status).toBe(200);
    db.exec('DELETE FROM capacity WHERE id = 1');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request('/api/health');

    expect(response.status).toBe(503);
    const body = await response.json() as { ok?: boolean; error: string; requestId: string };
    expect(body.ok).not.toBe(true);
    expect(body.error).not.toContain('schema');
    expect(body.requestId).toBe(response.headers.get('X-Request-ID'));
  });

  it('returns rate-limit retry guidance and fails closed when the limiter or database is unavailable', async () => {
    const cookie = await session();
    limitSuccess = false;
    const limited = await save(cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    limitSuccess = true;
    vi.spyOn(env.WRITE_LIMITER, 'limit').mockRejectedValueOnce(new Error('sensitive internal detail'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await save(cookie)).status).toBe(503);
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => { throw new Error('secret connection detail'); });
    const failure = await request('/api/reports', 'GET', cookie);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('secret');
    expect((await request('/api/health')).status).toBe(503);
  });
});
