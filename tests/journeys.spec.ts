import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fixtures } from '../src/core/fixtures';
import { evaluateTrace } from '../src/core/evaluate';
import type { Page } from '@playwright/test';

// Persistence is exercised against real bindings in the first journey. Other
// journeys isolate UI behavior and inject specific service responses explicitly.
test.beforeEach(async ({ page }, info) => {
  if (info.title.startsWith('[real storage]')) return;
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { retentionDays: 30, maxReports: 20 } }),
  );
  await page.route('**/api/reports', (route) => route.fulfill({ json: { reports: [] } }));
});

async function importJson(page: Page, value: unknown) {
  await page.getByRole('button', { name: 'Import trace', exact: true }).click();
  await page.getByLabel('Or paste trace JSON').fill(JSON.stringify(value));
  await page.getByRole('dialog').getByRole('button', { name: 'Import trace', exact: true }).click();
}

test('[real storage] audit, compare, export, re-import, save, reload, isolate and delete', async ({
  page,
  browser,
}) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const secondTab = await page.context().newPage();
  let sessionCreations = 0;
  page.context().on('request', (request) => {
    if (request.url().endsWith('/api/session') && request.method() === 'POST') sessionCreations++;
  });
  await Promise.all([page.goto('/'), secondTab.goto('/')]);
  await expect(page.getByText('Private browser session', { exact: true })).toBeVisible();
  await expect(secondTab.getByText('Private browser session', { exact: true })).toBeVisible();
  expect(sessionCreations).toBe(1);
  await secondTab.close();
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await expect(page.getByText('Evaluation complete', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected action evidence' })).toBeVisible();
  await page.getByRole('button', { name: 'Policy comparison', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('Current state');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadPromise;
  const bundle = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(bundle.trace).toEqual(fixtures[0].trace);
  expect(bundle.evaluation).toEqual(evaluateTrace(bundle.trace));
  await page.getByRole('button', { name: 'Import trace', exact: true }).click();
  await page.getByLabel('Or paste trace JSON').fill(JSON.stringify(bundle));
  await page.getByRole('dialog').getByRole('button', { name: 'Import trace', exact: true }).click();
  await expect(page.getByText('Trace imported locally.', { exact: false })).toBeVisible();

  const savedPromise = page.waitForResponse(
    (r) => r.url().endsWith('/api/reports') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Save report', exact: true }).click();
  await page.getByRole('button', { name: 'Save trace', exact: true }).click();
  const savedResponse = await savedPromise;
  expect(savedResponse.status()).toBe(201);
  const { report } = await savedResponse.json();
  const cookie = (await page.context().cookies()).find((c) => c.name.endsWith('acl_session'));
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  expect(cookie?.secure).toBe(new URL(page.url()).protocol === 'https:');
  await expect(page.getByRole('button', { name: 'Saved to library', exact: true })).toBeVisible();

  const other = await browser.newContext();
  const base = new URL(page.url()).origin;
  await other.request.post(`${base}/api/session`, { headers: { Origin: base }, data: {} });
  const foreignRead = await other.request.get(`${base}/api/reports/${report.id}`);
  expect(foreignRead.status()).toBe(404);
  const foreignDelete = await other.request.delete(`${base}/api/reports/${report.id}`, {
    headers: { Origin: base },
  });
  expect(foreignDelete.status()).toBe(404);
  await other.close();

  await page.reload();
  await page.getByRole('button', { name: /^Saved reports/ }).click();
  await expect(page.getByRole('heading', { name: report.title, exact: true })).toBeVisible();
  const libraryDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: `Export ${report.title}`, exact: true }).click();
  const savedBundle = JSON.parse(await readFile((await (await libraryDownload).path())!, 'utf8'));
  expect(savedBundle.trace).toEqual(bundle.trace);
  expect(savedBundle.evaluation).toEqual(bundle.evaluation);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await expect(page.getByText('Evaluation complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Saved reports/ }).click();
  await page.getByRole('button', { name: `Delete ${report.title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Keep report', exact: true }).click();
  await expect(page.getByRole('heading', { name: report.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Delete ${report.title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Delete report', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your first report belongs here.', exact: true }),
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('all eight fixtures export consistent policy results and expose supporting evidence', async ({
  page,
}) => {
  await page.goto('/');
  for (const fixture of fixtures) {
    await page.getByRole('button', { name: new RegExp(fixture.title) }).click();
    await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Selected action evidence' })).toBeVisible();
    await page.getByRole('button', { name: 'Static baseline', exact: true }).click();
    await page.getByRole('button', { name: 'Stateful policy', exact: true }).click();
    await page.getByText('View raw proposal', { exact: true }).click();
    await expect(page.locator('.raw-event pre')).toContainText('publish_artifact');
    await page.locator('.all-events > summary').click();
    await expect(page.locator('.all-events > div > details')).toHaveCount(
      fixture.trace.events.length,
    );
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
    const result = JSON.parse(await readFile((await (await downloading).path())!, 'utf8'));
    expect(result.trace).toEqual(fixture.trace);
    expect(result.evaluation).toEqual(evaluateTrace(fixture.trace));
  }
});

test('partial history and unsupported tools remain distinct and unlabelled metrics stay empty', async ({
  page,
}) => {
  const trace = structuredClone(fixtures[0].trace);
  trace.origin = 'captured';
  trace.coverage.authorization = 'partial';
  delete trace.labels;
  await page.goto('/');
  await importJson(page, trace);
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await expect(page.locator('.decision-callout .decision-review')).toBeVisible();
  await expect(page.getByText('Unlabelled.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Policy comparison', exact: true }).click();
  await expect(page.getByText('No eligible labels', { exact: true })).toHaveCount(6);
  const proposal = trace.events.find((event) => event.type === 'proposal')!;
  proposal.tool = 'send_email';
  await importJson(page, trace);
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await expect(page.locator('.decision-callout .decision-unsupported')).toBeVisible();
  await expect(page.locator('.summary-strip')).toContainText('0 supported · 1 unsupported');
});

test('file import enforces byte limits and safely displays long imported text on mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import trace', exact: true }).click();
  const input = page.getByLabel('Select trace JSON file');
  await input.setInputFiles({
    name: 'too-large.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(1024 * 1024 + 1, 32),
  });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('1 MiB');
  await input.setInputFiles({
    name: 'invalid-utf8.json',
    mimeType: 'application/json',
    buffer: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
  });
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('UTF-8');
  const trace = structuredClone(fixtures[0].trace);
  trace.title = '<img src=x onerror="window.importExecuted=true">' + 'W'.repeat(100);
  const proposal = trace.events.find((event) => event.type === 'proposal')!;
  proposal.resource = 'r'.repeat(100);
  proposal.destination = 'd'.repeat(200);
  proposal.tool = 't'.repeat(200);
  await input.setInputFiles({
    name: 'safe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(trace)),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Import trace', exact: true }).click();
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole('heading', { name: trace.title, exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'importExecuted' in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('quota and malformed service responses preserve local work and recover after retry', async ({
  page,
}) => {
  await page.route('**/api/reports', (route) => route.fulfill({ json: { reports: null } }));
  await page.goto('/');
  await expect(page.getByText('Storage unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Evaluate trace', exact: true })).toBeEnabled();
  await page.route('**/api/reports', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { reports: [] } })
      : route.fulfill({
          status: 429,
          headers: { 'Retry-After': '60' },
          json: { error: 'Write limit reached.', requestId: 'qa-limit' },
        }),
  );
  await page.getByRole('button', { name: 'Retry storage', exact: true }).click();
  await expect(page.getByText('Private browser session', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save report', exact: true }).click();
  await page.getByRole('button', { name: 'Save trace', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('60 seconds');
  await expect(page.getByRole('button', { name: 'Saved to library', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected action evidence' })).toBeVisible();
});

const savedFixture = () => ({
  id: 'f871300d-c4f9-41fc-b2f9-180ac7c7f282',
  title: fixtures[0].title,
  origin: 'fixture',
  createdAt: '2026-09-17T00:00:00.000Z',
  actionCount: 1,
  trace: fixtures[0].trace,
});

test('a delayed saved-report response cannot replace a newly selected fixture', async ({
  page,
}) => {
  const report = savedFixture();
  await page.route('**/api/reports', (route) => route.fulfill({ json: { reports: [report] } }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(`**/api/reports/${report.id}`, async (route) => {
    requested();
    await gate;
    await route.fulfill({ json: { report } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Saved reports/ }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await started;
  await page.getByRole('button', { name: new RegExp(fixtures[4].title) }).click();
  const completed = page.waitForResponse((r) => r.url().endsWith(report.id));
  release();
  await completed;
  await expect(page.getByRole('heading', { name: fixtures[4].title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save report', exact: true })).toBeVisible();
});

test('a stale library refresh cannot erase a report saved while it was loading', async ({
  page,
}) => {
  const report = savedFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshing!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshing = resolve;
  });
  let reads = 0;
  await page.route('**/api/reports', async (route) => {
    if (route.request().method() === 'POST')
      return route.fulfill({ status: 201, json: { report } });
    reads++;
    if (reads > 1) {
      refreshing();
      await gate;
    }
    await route.fulfill({ json: { reports: [] } });
  });
  await page.goto('/');
  await expect(page.getByText('Private browser session', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Saved reports/ }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await started;
  await page.getByRole('button', { name: /Trace workbench/ }).click();
  await page.getByRole('button', { name: 'Save report', exact: true }).click();
  await page.getByRole('button', { name: 'Save trace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved to library', exact: true })).toBeVisible();
  const completed = page.waitForResponse(
    (r) => r.url().endsWith('/api/reports') && r.request().method() === 'GET',
  );
  release();
  await completed;
  await page.getByRole('button', { name: /^Saved reports/ }).click();
  await expect(page.getByRole('heading', { name: report.title, exact: true })).toBeVisible();
});

test('cancelled digest verification cannot import a trace after the dialog closes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = SubtleCrypto.prototype.digest;
    SubtleCrypto.prototype.digest = function (...args) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        Object.assign(window, {
          finishImportDigest: () => original.apply(this, args).then(resolve, reject),
        });
      });
    };
  });
  const { createHash } = await import('node:crypto');
  const trace = fixtures[1].trace;
  const digest = createHash('sha256').update(JSON.stringify(trace)).digest('hex');
  await page.goto('/');
  await importJson(page, {
    format: 'agent-control-lab',
    schemaVersion: 1,
    trace,
    traceDigest: digest,
    digestAlgorithm: 'SHA-256',
  });
  await expect(page.getByRole('button', { name: 'Verifying…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { finishImportDigest: () => Promise<void> }).finishImportDigest(),
  );
  await expect(page.getByRole('heading', { name: fixtures[0].title, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('invalid input and an unavailable service never create false success', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Storage is unavailable.', requestId: 'test-unavailable' }),
    }),
  );
  await page.goto('/');
  await expect(page.getByText('Storage unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import trace', exact: true }).click();
  await page.getByLabel('Or paste trace JSON').fill('{');
  await page.getByRole('dialog').getByRole('button', { name: 'Import trace', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  await page.getByLabel('Or paste trace JSON').fill(
    JSON.stringify({
      format: 'agent-control-lab',
      schemaVersion: 1,
      trace: fixtures[0].trace,
      traceDigest: '0'.repeat(64),
      digestAlgorithm: 'SHA-256',
    }),
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Import trace', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/digest|checksum/i);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await expect(page.getByText('Evaluation complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save report', exact: true }).click();
  await page.getByRole('button', { name: 'Save trace', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Storage is unavailable');
  await expect(page.getByRole('button', { name: 'Saved to library', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  expect((await downloading).suggestedFilename()).toMatch(/audit\.json$/);
});

test('desktop and mobile have no serious accessibility violations or horizontal page overflow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await expect(page.getByText('Evaluation complete', { exact: true })).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => ({ target: n.target, reason: n.failureSummary })),
        })),
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (viewport.width === 390) {
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.keyboard.press('Shift+Tab');
      await expect(
        page.getByRole('button', { name: 'About this workspace', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(
        page.getByRole('link', { name: 'Agent Control Lab', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('button', { name: 'Open navigation', exact: true }),
      ).toBeFocused();
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('button', { name: /^Saved reports/ }).click();
      await expect(page.getByRole('heading', { name: 'Saved reports', exact: true })).toBeVisible();
      await expect(page.locator('#main-content')).toBeFocused();
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.setViewportSize({ width: 1000, height: 900 });
      await expect(page.locator('.main-shell')).not.toHaveAttribute('inert');
    }
  }
});

test('keyboard can reach import, complete its dialog, and return focus', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import trace', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Or paste trace JSON').fill(JSON.stringify(fixtures[1].trace));
  await page.getByRole('dialog').getByRole('button', { name: 'Import trace', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import trace', exact: true })).toBeFocused();
  await expect(
    page.getByRole('heading', { name: fixtures[1].trace.title, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Evaluation complete', { exact: true })).toBeVisible();
});

test('comparison, method, library and import dialog meet the accessibility target', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  for (const next of ['Policy comparison', 'Method & limits', 'Import trace', 'Saved reports']) {
    if (next === 'Saved reports')
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const button =
      next === 'Saved reports'
        ? page.getByRole('button', { name: /^Saved reports/ })
        : page.getByRole('button', { name: next, exact: true }).last();
    await button.click();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      results.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }
});

test('production assets fit the transfer budget and page becomes usable promptly', async ({
  page,
}) => {
  const responses: Promise<number>[] = [];
  page.on('response', (response) => {
    if (['script', 'stylesheet'].includes(response.request().resourceType())) {
      responses.push(response.body().then((body) => gzipSync(body).byteLength));
    }
  });
  const started = Date.now();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Evaluate trace', exact: true })).toBeEnabled();
  expect(Date.now() - started).toBeLessThan(10_000);
  await page.waitForLoadState('networkidle');
  const bytes = (await Promise.all(responses)).reduce((sum, n) => sum + n, 0);
  expect(bytes).toBeLessThan(250 * 1024);
  console.log(
    JSON.stringify({ gzipApplicationAssetBytes: bytes, usableWithinMs: Date.now() - started }),
  );
});
