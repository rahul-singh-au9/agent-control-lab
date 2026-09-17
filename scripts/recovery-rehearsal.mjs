import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const wrangler = path.join(project, 'node_modules/wrangler/bin/wrangler.js');
const port = Number(process.env.RECOVERY_PORT ?? 8794);
assert(
  Number.isInteger(port) && port > 1024 && port < 65536,
  'RECOVERY_PORT must be an unprivileged TCP port.',
);
const root = path.join(
  project,
  '.artifacts',
  `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const source = path.join(root, 'source');
const restored = path.join(root, 'restored');
const manifest = {
  startedAt: new Date().toISOString(),
  mode: 'local-only',
  artifacts: root,
  commands: [],
  checks: {},
};
const commandEnv = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
let worker;
let workerOutput = '';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function run(label, args) {
  const step = manifest.commands.length + 1;
  const command = { label, executable: process.execPath, args: [wrangler, ...args], cwd: project };
  manifest.commands.push(command);
  console.log(`${step}. ${label}`);
  try {
    const { stdout, stderr } = await execute(process.execPath, command.args, {
      cwd: project,
      env: commandEnv,
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(path.join(root, `${step}.log`), `${stdout}\n${stderr}`, { mode: 0o600 });
    return stdout;
  } catch (error) {
    await writeFile(
      path.join(root, `${step}.log`),
      `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
      { mode: 0o600 },
    );
    throw error;
  }
}

async function config(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'wrangler.json');
  await writeFile(
    filename,
    JSON.stringify(
      {
        name: 'agent-control-lab-recovery',
        main: path.join(project, 'worker/index.ts'),
        compatibility_date: '2026-09-17',
        workers_dev: false,
        assets: {
          directory: path.join(project, 'dist'),
          binding: 'ASSETS',
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api/*', '/__scheduled'],
        },
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'agent-control-lab',
            database_id: '00000000-0000-0000-0000-000000000000',
            migrations_dir: path.join(project, 'migrations'),
          },
        ],
        ratelimits: [
          { name: 'WRITE_LIMITER', namespace_id: '1001', simple: { limit: 10, period: 60 } },
        ],
        triggers: { crons: ['17 3 * * *'] },
        vars: { APP_VERSION: '1.0.0' },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return filename;
}

async function query(label, configuration, sql) {
  const output = await run(label, [
    'd1',
    'execute',
    'agent-control-lab',
    '--local',
    '--config',
    configuration,
    '--command',
    sql,
    '--json',
  ]);
  const result = JSON.parse(output);
  assert(
    result.every((statement) => statement.success),
    `${label} must complete successfully.`,
  );
  return result;
}

async function snapshot(label, configuration) {
  const result = await query(
    label,
    configuration,
    `
    SELECT (SELECT COUNT(*) FROM reports) AS actual_reports,
      (SELECT report_count FROM capacity WHERE id = 1) AS recorded_reports,
      (SELECT COUNT(*) FROM reports WHERE expires_at <= ${Date.now()}) AS expired_reports;
    SELECT type, name FROM sqlite_master WHERE name IN ('reports', 'capacity', 'reports_owner_created', 'reports_expiry', 'reports_insert_count', 'reports_delete_count') ORDER BY name;
    SELECT name FROM d1_migrations ORDER BY id;
  `,
  );
  const counts = result[0].results[0];
  assert.equal(
    counts.actual_reports,
    counts.recorded_reports,
    'Capacity counter must equal the number of rows.',
  );
  assert.deepEqual(result[1].results, [
    { type: 'table', name: 'capacity' },
    { type: 'table', name: 'reports' },
    { type: 'trigger', name: 'reports_delete_count' },
    { type: 'index', name: 'reports_expiry' },
    { type: 'trigger', name: 'reports_insert_count' },
    { type: 'index', name: 'reports_owner_created' },
  ]);
  assert.deepEqual(result[2].results, [{ name: '0001_reports.sql' }]);
  // D1 denies PRAGMA integrity_check. Inspect only this isolated, stopped local
  // SQLite database directly; this is not proof of remote database integrity.
  const persistence = path.join(path.dirname(configuration), '.wrangler/state/v3/d1');
  const files = (await readdir(persistence, { recursive: true })).filter(
    (filename) => filename.endsWith('.sqlite') && path.basename(filename) !== 'metadata.sqlite',
  );
  assert.equal(files.length, 1, 'Expected exactly one isolated local D1 SQLite file.');
  const localDb = new DatabaseSync(path.join(persistence, files[0]), { readOnly: true });
  try {
    assert.equal(localDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    localDb.close();
  }
  return {
    counts,
    schema: result[1].results,
    migrations: result[2].results,
    integrity: 'ok (local SQLite only)',
  };
}

async function stopWorker() {
  if (!worker) return;
  if (worker.exitCode === null && worker.signalCode === null) {
    const closed = new Promise((resolve) => worker.once('close', resolve));
    worker.kill('SIGTERM');
    await Promise.race([closed, pause(3_000)]);
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await Promise.race([closed, pause(3_000)]);
    }
  }
  await writeFile(path.join(root, 'worker.log'), workerOutput, { mode: 0o600 });
}

try {
  // Export has no --persist-to flag in the pinned Wrangler version. Each isolated
  // config therefore gets its own default .wrangler/state directory.
  await mkdir(root, { recursive: true, mode: 0o700 });
  await readFile(path.join(project, 'dist/index.html'));
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
  const sourceConfig = await config(source);
  const restoreConfig = await config(restored);
  await run('Apply migrations to an empty isolated source', [
    'd1',
    'migrations',
    'apply',
    'agent-control-lab',
    '--local',
    '--config',
    sourceConfig,
  ]);
  const now = Date.now();
  const trace = JSON.stringify({
    schemaVersion: 1,
    id: 'recovery-example',
    title: 'Synthetic recovery example',
    origin: 'fixture',
    coverage: { authorization: 'complete', resourceState: 'complete' },
    events: [
      {
        id: 'proposal-1',
        seq: 1,
        timestamp: '2026-01-15T09:00:00Z',
        type: 'proposal',
        source: 'agent',
        actionId: 'action-1',
        grantId: 'missing-approval',
        tool: 'publish_artifact',
        actor: 'synthetic-actor',
        session: 'synthetic-session',
        resource: 'example',
        destination: 'internal-review',
        version: 'v1',
        digest: 'a'.repeat(64),
      },
    ],
  });
  const insert = (id, expiresAt) =>
    `INSERT INTO reports (id, owner_id, title, origin, created_at, expires_at, action_count, trace) VALUES (${sqlLiteral(id)}, 'synthetic-owner-no-credential', 'Synthetic recovery example', 'fixture', ${now - 31 * 86_400_000}, ${expiresAt}, 1, ${sqlLiteral(trace)});`;
  const expiredId = '11111111-1111-4111-8111-111111111111';
  const retainedId = '22222222-2222-4222-8222-222222222222';
  const transientId = '33333333-3333-4333-8333-333333333333';
  await query(
    'Seed one expired and one unexpired synthetic report',
    sourceConfig,
    insert(expiredId, now - 86_400_000) + insert(retainedId, now + 86_400_000),
  );
  manifest.checks.source = await snapshot(
    'Verify source schema, counter, migration history and integrity',
    sourceConfig,
  );
  assert.deepEqual(manifest.checks.source.counts, {
    actual_reports: 2,
    recorded_reports: 2,
    expired_reports: 1,
  });
  const backup = path.join(root, 'backup.sql');
  await run('Export only the isolated local source database', [
    'd1',
    'export',
    'agent-control-lab',
    '--local',
    '--config',
    sourceConfig,
    '--output',
    backup,
  ]);
  assert((await readFile(backup, 'utf8')).includes('CREATE TRIGGER reports_insert_count'));
  await run('Restore SQL into a separate empty local database', [
    'd1',
    'execute',
    'agent-control-lab',
    '--local',
    '--config',
    restoreConfig,
    '--file',
    backup,
    '--yes',
  ]);
  manifest.checks.restored = await snapshot(
    'Verify restored schema, counter, history and integrity',
    restoreConfig,
  );
  assert.deepEqual(manifest.checks.restored, manifest.checks.source);
  await query(
    'Exercise the restored insertion trigger',
    restoreConfig,
    insert(transientId, now + 86_400_000),
  );
  const inserted = await query(
    'Check the restored insertion counter',
    restoreConfig,
    'SELECT report_count FROM capacity WHERE id = 1;',
  );
  assert.equal(inserted[0].results[0].report_count, 3);
  await query(
    'Exercise the restored deletion trigger',
    restoreConfig,
    `DELETE FROM reports WHERE id = ${sqlLiteral(transientId)};`,
  );
  manifest.checks.triggers = await snapshot(
    'Confirm restored trigger behavior and retained rows',
    restoreConfig,
  );
  assert.deepEqual(manifest.checks.triggers.counts, {
    actual_reports: 2,
    recorded_reports: 2,
    expired_reports: 1,
  });
  const args = [
    wrangler,
    'dev',
    '--local',
    '--config',
    restoreConfig,
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--inspector-port',
    '0',
    '--test-scheduled',
  ];
  manifest.commands.push({
    label: 'Serve the restored local database and invoke the actual scheduled handler',
    executable: process.execPath,
    args,
    cwd: project,
  });
  console.log(`${manifest.commands.length}. Start the restored local Worker on port ${port}`);
  worker = spawn(process.execPath, args, {
    cwd: project,
    env: commandEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', (chunk) => {
    workerOutput += chunk;
  });
  worker.stderr.on('data', (chunk) => {
    workerOutput += chunk;
  });
  let startupError;
  worker.once('error', (error) => {
    startupError = error;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    assert.equal(worker.exitCode, null, 'The isolated Worker exited before becoming healthy.');
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        manifest.checks.health = await response.json();
        healthy = true;
        break;
      }
    } catch {
      /* The local process may still be starting. */
    }
    await pause(200);
  }
  assert(healthy, 'The restored local Worker must become healthy.');
  assert.equal(manifest.checks.health.ok, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/__scheduled?cron=${encodeURIComponent('17 3 * * *')}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(body, 'Ran scheduled event');
    manifest.checks[`scheduled${attempt + 1}`] = { status: response.status, body };
  }
  await stopWorker();
  manifest.checks.afterCleanup = await snapshot(
    'Verify actual scheduled cleanup and idempotence',
    restoreConfig,
  );
  assert.deepEqual(manifest.checks.afterCleanup.counts, {
    actual_reports: 1,
    recorded_reports: 1,
    expired_reports: 0,
  });
  const survivor = await query(
    'Verify cleanup preserved only the unexpired report',
    restoreConfig,
    'SELECT id FROM reports;',
  );
  assert.deepEqual(survivor[0].results, [{ id: retainedId }]);
  manifest.checks.sourceUnchanged = await snapshot(
    'Verify the isolated export source was unchanged',
    sourceConfig,
  );
  assert.deepEqual(manifest.checks.sourceUnchanged, manifest.checks.source);
  manifest.status = 'passed';
  console.log(`Recovery rehearsal passed. Evidence: ${path.join(root, 'manifest.json')}`);
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error instanceof Error ? error.message : String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopWorker();
  manifest.completedAt = new Date().toISOString();
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
}
