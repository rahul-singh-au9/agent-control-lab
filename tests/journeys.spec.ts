import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fixtures } from '../src/core/fixtures';
import { evaluateTrace } from '../src/core/evaluate';

test('audit, compare, export, re-import, save, reload, isolate and delete', async ({page, browser}) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Private browser session', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Evaluate trace', exact:true}).click();
  await expect(page.getByText('Evaluation complete', {exact:true})).toBeVisible();
  await expect(page.getByRole('region', {name:'Selected action evidence'})).toBeVisible();
  await page.getByRole('button', {name:'Policy comparison', exact:true}).click();
  await expect(page.getByRole('table')).toContainText('Current state');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name:'Export JSON', exact:true}).click();
  const download = await downloadPromise;
  const bundle = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(bundle.trace).toEqual(fixtures[0].trace);
  expect(bundle.evaluation).toEqual(evaluateTrace(bundle.trace));
  await page.getByRole('button', {name:'Import trace', exact:true}).click();
  await page.getByLabel('Or paste trace JSON').fill(JSON.stringify(bundle));
  await page.getByRole('dialog').getByRole('button', {name:'Import trace',exact:true}).click();
  await expect(page.getByText('Trace imported locally.', {exact:false})).toBeVisible();

  const savedPromise = page.waitForResponse(r => r.url().endsWith('/api/reports') && r.request().method() === 'POST');
  await page.getByRole('button', {name:'Save report',exact:true}).click();
  await page.getByRole('button', {name:'Save trace',exact:true}).click();
  const savedResponse = await savedPromise;
  expect(savedResponse.status()).toBe(201);
  const {report} = await savedResponse.json();
  const cookie = (await page.context().cookies()).find(c => c.name.endsWith('acl_session'));
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  expect(cookie?.secure).toBe(new URL(page.url()).protocol === 'https:');
  await expect(page.getByRole('button',{name:'Saved to library',exact:true})).toBeVisible();

  const other = await browser.newContext();
  const base = new URL(page.url()).origin;
  await other.request.post(`${base}/api/session`, {headers:{Origin:base},data:{}});
  const foreignRead = await other.request.get(`${base}/api/reports/${report.id}`);
  expect(foreignRead.status()).toBe(404);
  const foreignDelete = await other.request.delete(`${base}/api/reports/${report.id}`,{headers:{Origin:base}});
  expect(foreignDelete.status()).toBe(404);
  await other.close();

  await page.reload();
  await page.getByRole('button', {name:/^Saved reports/}).click();
  await expect(page.getByRole('heading',{name:report.title,exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Open',exact:true}).click();
  await page.getByRole('button', {name:'Evaluate trace',exact:true}).click();
  await expect(page.getByText('Evaluation complete', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:/^Saved reports/}).click();
  await page.getByRole('button', {name:`Delete ${report.title}`,exact:true}).click();
  await page.getByRole('button',{name:'Delete report',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your first report belongs here.',exact:true})).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('invalid input and an unavailable service never create false success', async ({page}) => {
  await page.route('**/api/**', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Storage is unavailable.',requestId:'test-unavailable'})}));
  await page.goto('/');
  await expect(page.getByText('Storage unavailable',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Import trace',exact:true}).click();
  await page.getByLabel('Or paste trace JSON').fill('{');
  await page.getByRole('dialog').getByRole('button',{name:'Import trace',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  await page.getByLabel('Or paste trace JSON').fill(JSON.stringify({format:'agent-control-lab',schemaVersion:1,trace:fixtures[0].trace,traceDigest:'0'.repeat(64),digestAlgorithm:'SHA-256'}));
  await page.getByRole('dialog').getByRole('button',{name:'Import trace',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(/digest|checksum/i);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Evaluate trace',exact:true}).click();
  await expect(page.getByText('Evaluation complete',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Save report',exact:true}).click();
  await page.getByRole('button',{name:'Save trace',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Storage is unavailable');
  await expect(page.getByRole('button',{name:'Saved to library',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button',{name:'Export JSON',exact:true}).click();
  expect((await downloading).suggestedFilename()).toMatch(/audit\.json$/);
});

test('desktop and mobile have no serious accessibility violations or horizontal page overflow', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'Evaluate trace',exact:true}).click();
  await expect(page.getByText('Evaluation complete',{exact:true})).toBeVisible();
  for (const viewport of [{width:1440,height:960},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    const results = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(results.violations.filter(v => ['serious','critical'].includes(v.impact ?? '')).map(v => ({
      id:v.id, impact:v.impact, nodes:v.nodes.map(n => ({target:n.target,reason:n.failureSummary})),
    }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (viewport.width === 390) {
      await page.getByRole('button',{name:'Open navigation',exact:true}).click();
      await page.getByRole('button',{name:/^Saved reports/}).click();
      await expect(page.getByRole('heading',{name:'Saved reports',exact:true})).toBeVisible();
    }
  }
});

test('keyboard can reach import, complete its dialog, and return focus', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'Import trace',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Or paste trace JSON').fill(JSON.stringify(fixtures[1].trace));
  await page.getByRole('dialog').getByRole('button',{name:'Import trace',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Import trace',exact:true})).toBeFocused();
  await expect(page.getByRole('heading',{name:fixtures[1].trace.title,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Evaluate trace',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Evaluation complete',{exact:true})).toBeVisible();
});

test('comparison, method, library and import dialog meet the accessibility target', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button',{name:'Evaluate trace',exact:true}).click();
  for (const next of ['Policy comparison','Method & limits','Import trace','Saved reports']) {
    if (next === 'Saved reports') await page.getByRole('button',{name:'Cancel',exact:true}).click();
    const button = next === 'Saved reports' ? page.getByRole('button',{name:/^Saved reports/}) : page.getByRole('button',{name:next,exact:true}).last();
    await button.click();
    const results = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(results.violations.filter(v => ['serious','critical'].includes(v.impact ?? '')).map(v => ({id:v.id, targets:v.nodes.map(n => n.target)}))).toEqual([]);
  }
});

test('production assets fit the transfer budget and page becomes usable promptly', async ({page}) => {
  const responses: Promise<number>[] = [];
  page.on('response', response => {
    if (['script','stylesheet'].includes(response.request().resourceType())) {
      responses.push(response.body().then(body => gzipSync(body).byteLength));
    }
  });
  const started = Date.now();
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Evaluate trace',exact:true})).toBeEnabled();
  expect(Date.now() - started).toBeLessThan(10_000);
  await page.waitForLoadState('networkidle');
  const bytes = (await Promise.all(responses)).reduce((sum,n) => sum+n,0);
  expect(bytes).toBeLessThan(250 * 1024);
  console.log(JSON.stringify({gzipApplicationAssetBytes:bytes,usableWithinMs:Date.now()-started}));
});
