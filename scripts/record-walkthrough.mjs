import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) {
  throw new Error('The walkthrough creates synthetic records. Use a local preview.');
}
const output = fileURLToPath(new URL('../.artifacts/walkthrough/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ slowMo: 180 });
const pauseMs = Number(process.env.RECORD_PAUSE_MS ?? 3000);
const recordings = [];

async function record(name, viewport, journey) {
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: output, size: viewport },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const started = Date.now();
  const chapters = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const hold = (factor = 1) => page.waitForTimeout(pauseMs * factor);
  const chapter = async (title, note = '') => {
    chapters.push({ seconds: Number(((Date.now() - started) / 1000).toFixed(2)), title, note });
    console.log(`${name}: ${title}`);
  };
  let completed = false;
  try {
    await page.goto(baseURL);
    await expect(page.getByRole('button', { name: 'Evaluate trace', exact: true })).toBeVisible();
    await journey({ page, context, hold, chapter });
    expect(errors).toEqual([]);
    completed = true;
  } finally {
    await context.close();
    const original = await page.video().path();
    const filename = `${name}${completed ? '' : '-incomplete'}.webm`;
    await rename(original, `${output}/${filename}`);
    recordings.push({
      name,
      filename,
      viewport,
      completed,
      durationSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      chapters,
      errors,
    });
    await writeFile(
      `${output}/chapters.json`,
      JSON.stringify({ baseURL, recordedAt: new Date().toISOString(), recordings }, null, 2),
    );
  }
}

async function evaluate(page) {
  await page.getByRole('button', { name: 'Evaluate trace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected action evidence' })).toBeVisible();
}
async function download(page, name = 'Export JSON') {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const file = await downloading;
  const data = JSON.parse(await readFile(await file.path(), 'utf8'));
  await file.saveAs(`${output}/${file.suggestedFilename()}`);
  return data;
}
async function importValue(page, value) {
  await page.getByRole('button', { name: 'Import trace', exact: true }).click();
  await page.getByLabel('Or paste trace JSON').fill(JSON.stringify(value, null, 2));
  await page.getByRole('dialog').getByRole('button', { name: 'Import trace', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
const fixtureNames = [
  'Approval claimed in a document',
  'A recorded approval matches',
  'Destination changed after approval',
  'The approved destination is used',
  'Approval revoked before publication',
  'Approval remains active',
  'Content changed after approval',
  'Revised content receives new approval',
];

try {
  await record(
    'agent-control-lab-desktop',
    { width: 1440, height: 1000 },
    async ({ page, hold, chapter }) => {
      await chapter(
        'Local workspace and private storage',
        'Real local Worker API and D1 persistence. Synthetic traces only.',
      );
      await expect(page.getByText('Private browser session', { exact: true })).toBeVisible();
      await hold();
      const examples = [];
      for (let i = 0; i < fixtureNames.length; i++) {
        await chapter(`Example ${i + 1}: ${fixtureNames[i]}`);
        await page.getByRole('button', { name: new RegExp(fixtureNames[i]) }).click();
        await evaluate(page);
        await page.locator('.audit-panel').scrollIntoViewIfNeeded();
        await hold();
        if (i === 0) {
          await page.locator('.event-evidence > summary').first().click();
          await hold();
          await page.locator('.event-evidence > summary').first().click();
          await page.locator('.raw-event > summary').click();
          await hold();
          await page.locator('.raw-event > summary').click();
          await page.locator('.all-events > summary').click();
          await page.locator('.all-events > div > details > summary').first().click();
          await hold();
        }
        if (i === 4 || i === 6) {
          await page.getByRole('button', { name: 'Static baseline', exact: true }).click();
          await hold();
          await page.getByRole('button', { name: 'Stateful policy', exact: true }).click();
          await page.getByRole('button', { name: 'Policy comparison', exact: true }).click();
          await page.locator('.comparison-view').scrollIntoViewIfNeeded();
          await hold();
        }
        examples.push(await download(page));
      }
      await chapter('Import a multi-action trace: use allowance and unsupported tools');
      const multi = structuredClone(examples[1].trace);
      multi.id = 'dispatch-allowance-demonstration';
      multi.title = 'One approval, a dispatch, and a later attempt';
      multi.origin = 'captured';
      delete multi.labels;
      const proposal = multi.events.find((event) => event.type === 'proposal');
      const stamp = (seq) => ({
        id: `event-${seq}`,
        seq,
        timestamp: `2026-01-15T09:00:${String(seq).padStart(2, '0')}Z`,
      });
      multi.events.push(
        { ...stamp(5), type: 'dispatch', source: 'tool', actionId: proposal.actionId },
        {
          ...stamp(6),
          type: 'result',
          source: 'tool',
          actionId: proposal.actionId,
          outcome: 'failed',
        },
        { ...proposal, ...stamp(7), actionId: 'publish-2' },
        { ...proposal, ...stamp(8), actionId: 'send-3', tool: 'send_email' },
      );
      await importValue(page, multi);
      await evaluate(page);
      for (const action of await page.locator('.timeline-action').all()) {
        await action.click();
        await page.locator('.decision-detail').scrollIntoViewIfNeeded();
        await hold();
      }
      await chapter('Incomplete history requests review; unlabelled accuracy is unavailable');
      const partial = structuredClone(examples[0].trace);
      partial.coverage.authorization = 'partial';
      partial.origin = 'captured';
      delete partial.labels;
      await importValue(page, partial);
      await evaluate(page);
      await hold();
      await page.getByRole('button', { name: 'Policy comparison', exact: true }).click();
      await hold();

      await chapter('Save, reload, reopen and export a database-backed report');
      await importValue(page, examples[4]);
      await evaluate(page);
      await page.getByRole('button', { name: 'Save report', exact: true }).click();
      await hold();
      const saved = page.waitForResponse(
        (r) => r.url().endsWith('/api/reports') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Save trace', exact: true }).click();
      expect((await saved).status()).toBe(201);
      await expect(
        page.getByRole('button', { name: 'Saved to library', exact: true }),
      ).toBeVisible();
      await hold();
      await page.reload();
      await page.getByRole('button', { name: /^Saved reports/ }).click();
      await expect(page.getByRole('heading', { name: fixtureNames[4], exact: true })).toBeVisible();
      await hold();
      await download(page, `Export ${fixtureNames[4]}`);
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await evaluate(page);
      await hold();
      await page.getByRole('button', { name: /^Saved reports/ }).click();
      await page.getByRole('button', { name: `Delete ${fixtureNames[4]}`, exact: true }).click();
      await hold();
      await page.getByRole('button', { name: 'Keep report', exact: true }).click();
      await page.getByRole('button', { name: `Delete ${fixtureNames[4]}`, exact: true }).click();
      await page.getByRole('button', { name: 'Delete report', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Your first report belongs here.', exact: true }),
      ).toBeVisible();
      await hold();
      await page.getByRole('button', { name: 'Open workbench', exact: true }).click();

      await chapter('JSON validation and tampered export detection');
      await page.getByRole('button', { name: 'Import trace', exact: true }).click();
      await page.getByLabel('Or paste trace JSON').fill('{');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Import trace', exact: true })
        .click();
      await expect(page.getByRole('alert')).toContainText('not valid JSON');
      await hold();
      await page
        .getByLabel('Or paste trace JSON')
        .fill(JSON.stringify({ ...examples[0], traceDigest: '0'.repeat(64) }, null, 2));
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Import trace', exact: true })
        .click();
      await expect(page.getByRole('alert')).toContainText('digest');
      await hold();
      await chapter('Re-import an exported file');
      await page.getByLabel('Select trace JSON file').setInputFiles({
        name: 'exported-report.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(examples[0])),
      });
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Import trace', exact: true })
        .click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await evaluate(page);
      await hold();

      await chapter(
        'Storage failure: local evaluation and export keep working',
        'Storage 503 responses are deliberately injected for this demonstration.',
      );
      await page.route('**/api/**', (route) =>
        route.fulfill({
          status: 503,
          json: {
            error: 'Storage unavailable for this failure demonstration.',
            requestId: 'walkthrough-failure',
          },
        }),
      );
      await page.reload();
      await expect(page.getByText('Storage unavailable', { exact: true })).toBeVisible();
      await evaluate(page);
      await download(page);
      await hold();
      await page.getByRole('button', { name: 'Save report', exact: true }).click();
      await page.getByRole('button', { name: 'Save trace', exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
      await hold();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.unroute('**/api/**');
      await page.getByRole('button', { name: 'Retry storage', exact: true }).click();
      await expect(page.getByText('Private browser session', { exact: true })).toBeVisible();
      await hold();
      await chapter('Method, evidence boundaries and privacy');
      await page.getByRole('button', { name: 'Method & limits', exact: true }).last().click();
      await page.locator('.method-grid').scrollIntoViewIfNeeded();
      await hold();
      await page.locator('.method-boundaries').scrollIntoViewIfNeeded();
      await hold(2);
    },
  );

  await record(
    'agent-control-lab-mobile',
    { width: 390, height: 844 },
    async ({ page, hold, chapter }) => {
      await chapter('Mobile workbench at 390 pixels');
      await hold();
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await hold();
      await page.getByRole('button', { name: new RegExp(fixtureNames[4]) }).click();
      await evaluate(page);
      await page.locator('.summary-strip').scrollIntoViewIfNeeded();
      await hold();
      await page.locator('.timeline-pane').scrollIntoViewIfNeeded();
      await hold();
      await page.locator('.decision-detail').scrollIntoViewIfNeeded();
      await hold();
      await chapter('Mobile policy comparison');
      await page.getByRole('button', { name: 'Policy comparison', exact: true }).click();
      await page.locator('.comparison-cards').scrollIntoViewIfNeeded();
      await hold();
      await page.locator('.comparison-table-wrap').scrollIntoViewIfNeeded();
      await hold();
      await chapter('Mobile import and keyboard dismissal');
      await page.getByRole('button', { name: 'Import trace', exact: true }).click();
      await hold();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Import trace', exact: true })).toBeFocused();
      await chapter('Mobile saved library and method');
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('button', { name: /^Saved reports/ }).click();
      await expect(page.getByRole('heading', { name: 'Saved reports', exact: true })).toBeVisible();
      await hold();
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('button', { name: 'Method & limits', exact: true }).click();
      await page.locator('.method-boundaries').scrollIntoViewIfNeeded();
      await hold();
    },
  );
} finally {
  await browser.close();
}
console.log(`Recordings and chapter timings saved in ${output}`);
