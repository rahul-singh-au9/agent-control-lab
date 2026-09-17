import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

// Run one mode at a time against the owned deployment, allowing the write window
// to expire between modes. This script never retries a report creation.
const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    mode: { type: 'string', default: 'smoke' },
    'worker-name': { type: 'string', default: 'agent-control-lab' },
    prefix: { type: 'string', default: 'live-check' },
  },
});
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
check(values['base-url'], 'Supply --base-url with the owned HTTPS workers.dev application URL.');
check(
  /^agent-control-lab(?:-[a-z0-9]+)*$/.test(values['worker-name']) &&
    values['worker-name'].length <= 63,
  '--worker-name must be agent-control-lab or an explicitly named suffix of it.',
);
check(/^[a-z][a-z0-9-]{0,30}$/.test(values.prefix), '--prefix must be a short lowercase label.');
const base = new URL(values['base-url']);
check(
  base.protocol === 'https:' &&
    new RegExp(`^${values['worker-name']}\\.[a-z0-9-]+\\.workers\\.dev$`).test(base.hostname) &&
    !base.port &&
    !base.username &&
    !base.password &&
    base.pathname === '/' &&
    !base.search &&
    !base.hash,
  '--base-url must be the HTTPS origin of the named workers.dev application.',
);
check(
  ['smoke', 'max-payload', 'invalid', 'rate-limit'].includes(values.mode),
  '--mode must be smoke, max-payload, invalid, or rate-limit.',
);
const marker = `${values.prefix}-${randomUUID()}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ownedIds = new Set();
const summary = {
  mode: values.mode,
  origin: base.origin,
  marker,
  startedAt: new Date().toISOString(),
  timingScope: 'HTTP wall time only; not Worker CPU time',
  observations: [],
  unknownSaveOutcome: false,
};
let cookie;
let cooldownUntil = 0;

async function request(label, route, { method = 'GET', body, origin = base.origin } = {}) {
  check(
    ['/', '/api/health', '/api/session', '/api/reports', '/api/verification-missing'].includes(
      route,
    ) ||
      (route.startsWith('/api/reports/') && uuid.test(route.slice('/api/reports/'.length))),
    'Verification route is outside the fixed allowlist.',
  );
  if (method === 'DELETE') {
    check(
      ownedIds.has(route.slice('/api/reports/'.length)),
      'Refusing an unowned report deletion.',
    );
  }
  const headers = { 'X-Verification-Run': marker };
  if (cookie) headers.Cookie = cookie;
  if (method !== 'GET') headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const started = performance.now();
  let response;
  let text;
  try {
    response = await fetch(new URL(route, base), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    text = await response.text();
  } catch {
    throw new Error(`${label}: transport failed; no automatic retry was performed.`);
  }
  const requestId = response.headers.get('X-Request-ID');
  summary.observations.push({
    check: label,
    method,
    route,
    status: response.status,
    httpElapsedMs: Number((performance.now() - started).toFixed(2)),
    ...(uuid.test(requestId ?? '') ? { requestId } : {}),
  });
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'));
    check(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60, 'Invalid Retry-After.');
    cooldownUntil = Date.now() + seconds * 1_000 + 1_000;
    summary.retryAfterSeconds = seconds;
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json() {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${label}: expected valid JSON.`);
      }
    },
  };
}

function acceptSession(response) {
  check(response.status === 200, 'Session creation did not succeed.');
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('__Host-acl_session='));
  check(
    /^__Host-acl_session=[a-f0-9]{64};/.test(setCookie ?? '') &&
      /;\s*HttpOnly(?:;|$)/i.test(setCookie) &&
      /;\s*Secure(?:;|$)/i.test(setCookie) &&
      /;\s*SameSite=Strict(?:;|$)/i.test(setCookie) &&
      /;\s*Path=\/(?:;|$)/i.test(setCookie) &&
      !/;\s*Domain=/i.test(setCookie),
    'Session cookie protections are incomplete.',
  );
  cookie = setCookie.split(';')[0];
  const body = response.json();
  check(body.retentionDays === 30 && body.maxReports === 20, 'Unexpected session limits.');
}

function maxTrace() {
  const binding = {
    actor: 'publisher',
    session: 'session-1',
    resource: 'release-brief',
    destination: 'internal-review',
    version: 'v1',
    digest: 'a'.repeat(64),
  };
  const stamp = (seq) => ({
    id: `event-${seq}`,
    seq,
    timestamp: new Date(Date.UTC(2026, 0, 15, 9, 0, seq)).toISOString(),
  });
  const trace = {
    schemaVersion: 1,
    id: marker,
    title: `Synthetic maximum-payload verification ${marker}`,
    origin: 'fixture',
    coverage: { authorization: 'complete', resourceState: 'complete' },
    events: [
      {
        ...stamp(1),
        type: 'state',
        source: 'resource',
        resource: binding.resource,
        version: binding.version,
        digest: binding.digest,
      },
      {
        ...stamp(2),
        type: 'grant',
        source: 'authority',
        grantId: 'approval-1',
        ...binding,
        expiresAt: '2026-01-15T09:30:00Z',
        maxUses: 1,
      },
    ],
    labels: [],
  };
  for (let seq = 3; seq <= 200; seq++) {
    if (seq <= 82) {
      const actionId = `publish-${seq}`;
      trace.events.push({
        ...stamp(seq),
        type: 'proposal',
        source: 'agent',
        actionId,
        grantId: 'approval-1',
        tool: 'publish_artifact',
        ...binding,
      });
      trace.labels.push({
        actionId,
        expected: 'permitted',
        ruleId: 'matching-grant-and-state',
        evidenceEventIds: ['event-1', 'event-2', `event-${seq}`],
      });
    } else {
      trace.events.push({ ...stamp(seq), type: 'context', source: 'tool', content: '' });
    }
  }
  let remaining = 65_536 - Buffer.byteLength(JSON.stringify(trace));
  check(remaining >= 0, 'Synthetic trace exceeded its byte budget before padding.');
  for (const event of trace.events) {
    if (event.type !== 'context' || !remaining) continue;
    const bytes = Math.min(8_000, remaining);
    event.content = 'x'.repeat(bytes);
    remaining -= bytes;
  }
  check(
    remaining === 0 && Buffer.byteLength(JSON.stringify(trace)) === 65_536,
    'Synthetic trace size is incorrect.',
  );
  return trace;
}

async function smoke() {
  const page = await request('static page', '/');
  check(
    page.status === 200 && page.text.includes('Agent Control Lab'),
    'Static application is unavailable.',
  );
  for (const [header, expected] of [
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'no-referrer'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
  ])
    check(page.headers.get(header) === expected, `Missing static protection: ${header}.`);
  check(
    page.headers.get('Content-Security-Policy')?.includes("frame-ancestors 'none'"),
    'Static CSP is missing.',
  );
  check(
    page.headers.get('Strict-Transport-Security')?.includes('max-age=31536000'),
    'Static HSTS is missing.',
  );
  const health = await request('database health', '/api/health');
  check(health.status === 200 && health.json().ok === true, 'Database-backed health check failed.');
  check(health.headers.get('Cache-Control') === 'no-store', 'API responses must not be cached.');
  check(
    (await request('anonymous session', '/api/session')).status === 401,
    'Anonymous session did not return 401.',
  );
  check(
    (await request('anonymous library', '/api/reports')).status === 401,
    'Anonymous library did not return 401.',
  );
  check(
    (await request('unknown route', '/api/verification-missing')).status === 404,
    'Unknown endpoint did not return 404.',
  );
  const method = await request('unsupported method', '/api/reports', { method: 'PUT', body: {} });
  check(
    method.status === 405 && method.headers.get('Allow') === 'GET, POST',
    'Method rejection is incorrect.',
  );
  check(
    (
      await request('cross-origin mutation', '/api/session', {
        method: 'POST',
        body: {},
        origin: 'https://example.invalid',
      })
    ).status === 403,
    'Cross-origin mutation did not return 403.',
  );
}

async function verifyMaxPayload() {
  acceptSession(
    await request('create synthetic session', '/api/session', { method: 'POST', body: {} }),
  );
  const trace = maxTrace();
  summary.traceBytes = Buffer.byteLength(JSON.stringify(trace));
  summary.eventCount = trace.events.length;
  for (let attempt = 1; attempt <= 3; attempt++) {
    summary.unknownSaveOutcome = true;
    const saved = await request(`save maximum trace ${attempt}`, '/api/reports', {
      method: 'POST',
      body: { trace },
    });
    if (saved.status >= 400 && saved.status < 500) summary.unknownSaveOutcome = false;
    check(saved.status === 201, `Maximum trace ${attempt} was not saved.`);
    const report = saved.json().report;
    check(uuid.test(report?.id ?? ''), 'Save response did not identify the created report.');
    ownedIds.add(report.id);
    summary.unknownSaveOutcome = false;
    check(
      JSON.stringify(report.trace) === JSON.stringify(trace),
      'Saved trace differed from the submitted synthetic trace.',
    );
    const retrieved = await request(`read maximum trace ${attempt}`, `/api/reports/${report.id}`);
    check(
      retrieved.status === 200 &&
        JSON.stringify(retrieved.json().report?.trace) === JSON.stringify(trace),
      'Stored maximum trace did not round-trip.',
    );
  }
}

async function invalid() {
  acceptSession(
    await request('create synthetic session', '/api/session', { method: 'POST', body: {} }),
  );
  const trace = {
    schemaVersion: 1,
    id: marker,
    title: 'Synthetic malformed-array verification',
    origin: 'fixture',
    coverage: { authorization: 'complete', resourceState: 'complete' },
    events: Array(12_000).fill(null),
  };
  check(
    Buffer.byteLength(JSON.stringify(trace)) < 65_536,
    'Invalid input must remain below the byte limit.',
  );
  const response = await request('reject excessive event array', '/api/reports', {
    method: 'POST',
    body: { trace },
  });
  check(
    response.status === 400 && response.json().error === 'events: Use at most 200 items.',
    'Excessive array was not rejected by the collection preflight.',
  );
  const reports = await request('malformed input did not save', '/api/reports');
  check(
    reports.status === 200 && reports.json().reports?.length === 0,
    'Malformed input created a report.',
  );
}

async function rateLimit() {
  summary.rateLimitObserved = false;
  for (let attempt = 1; attempt <= 15; attempt++) {
    const response = await request(`bounded session limit probe ${attempt}`, '/api/session', {
      method: 'POST',
      body: {},
    });
    if (response.status === 429) {
      summary.rateLimitObserved = true;
      break;
    }
    acceptSession(response);
    if (attempt < 15) await pause(100);
  }
  summary.recovery =
    'Caller must wait at least 61 seconds after the final write, then run invalid or max-payload to verify writes recover.';
  if (!summary.rateLimitObserved) {
    summary.result = 'inconclusive';
    summary.reason =
      'No rejection observed within 15 requests; approximate counters were not load-tested further.';
    process.exitCode = 2;
  }
}

try {
  if (values.mode === 'smoke') await smoke();
  else if (values.mode === 'max-payload') await verifyMaxPayload();
  else if (values.mode === 'invalid') await invalid();
  else await rateLimit();
  summary.result ??= 'passed';
} catch (error) {
  summary.result = 'failed';
  summary.error = error instanceof Error ? error.message : 'Verification failed.';
  process.exitCode = 1;
} finally {
  if (ownedIds.size && cooldownUntil > Date.now()) {
    console.log(
      JSON.stringify({ cleanupWaitingForRateLimit: true, remainingReports: ownedIds.size }),
    );
    await pause(cooldownUntil - Date.now());
  }
  for (const id of ownedIds) {
    try {
      const response = await request('delete identified synthetic report', `/api/reports/${id}`, {
        method: 'DELETE',
      });
      if (response.status === 200 || response.status === 404) ownedIds.delete(id);
      if (response.status === 429) break;
    } catch {
      // Each identified report receives at most one cleanup attempt.
    }
  }
  summary.remainingReportIds = [...ownedIds];
  if (ownedIds.size || summary.unknownSaveOutcome) {
    summary.result = 'failed';
    summary.cleanup =
      'Manual review required for only the listed IDs or this exact synthetic marker.';
    process.exitCode = 1;
  }
  cookie = undefined;
  summary.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(summary, null, 2));
}
