# Agent Control Lab

Audit recorded agent actions against approvals and resource state. Compare a static scope policy with a policy that tracks revoked and expired grants, prior dispatches, and content changes. Inspect the evidence for each decision and export a reproducible report.

The application accepts one explicit JSON trace contract. It supports `publish_artifact` actions; other tools remain visibly unsupported. Bundled scenarios are **authored educational fixtures**, not model benchmark results. The evaluator audits recorded proposals. It does not execute tools, call a model, or establish how an agent would behave after an intervention.

## Features

- Import and validate a trace, or explore paired permitted/forbidden examples.
- Evaluate both versioned policies against the same recorded history.
- Inspect allow, block, review, and unsupported decisions with referenced evidence.
- Show reference-label coverage and policy metrics with their numerators and denominators. Missing labels do not become invented accuracy scores.
- Export/import reports. Evaluation happens in the browser before any explicit save.
- Save up to 20 reports in a private browser workspace backed by D1. Reports expire after 30 days. Export them for longer retention or transfer to another browser.
- Continue local auditing and export if the storage service is unavailable.

The saved-report cookie is a bearer credential, not a verified user account. Clearing it loses access; there is no account recovery. A server operator can access stored traces. Sanitize proprietary information, personal information and credentials before saving.

## Run locally

Use Node 24.21.0 (see `.nvmrc`) and npm. There are no model keys or paid APIs.

```sh
npm ci
npm run build
npm run db:migrate:local
npm run preview
```

Open `http://127.0.0.1:8787`. This serves the production frontend and Worker API with local D1 and rate-limiter bindings. For frontend hot reload, leave the preview running and start `npm run dev` in another terminal; Vite proxies API requests to the local Worker.

```sh
npm run check
npm run audit:dependencies
npx playwright install chromium
npm run test:e2e
```

`npm run check` runs strict TypeScript checks, engine/API tests, and the production build. Browser tests start an isolated backend on port 8788 with their own `.wrangler/test-state` database. They do not use the manual preview's records or rate-limit counters. CI repeats these checks on Linux.

## Architecture

```text
React + TypeScript
  ├─ JSON validation → pure deterministic evaluator → inspection/export
  └─ explicit save → same-origin Worker → owner-scoped D1 rows
```

- `src/core`: bounded schema, timeline validation, policy evaluator, fixtures and invariant tests.
- `src/ui`: accessible inspection workspace and API client.
- `worker`: session, report API, quota enforcement and retention cleanup.
- `migrations`: versioned, forward-only database changes.
- `tests`: browser journeys, accessibility and actual local backend verification.

React matches the portfolio's existing frontend stack. A shared TypeScript schema prevents frontend/backend input drift. Vite produces static assets, while one Worker and one D1 database provide persistence without a separate server or authentication provider. Prepared SQLite statements keep deployment and migration simple. The evaluator has no network access or runtime scripting interface.

Dependencies are pinned in `package-lock.json`. Stable releases were checked on 2026-09-17. The intentionally narrow product does not depend on a browser model download, hosted inference, external tool credentials or a beta application framework.

## Deploy without charges

Use a **Workers Free** account and the provided `workers.dev` subdomain. Verify the selected account's plan first; an existing paid account does not inherit Free protections from this repository. Do not upgrade or supply payment details to resolve quota errors.

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create agent-control-lab
```

Replace the all-zero `database_id` in `wrangler.jsonc` with the newly created database's ID, then:

```sh
npm run db:migrate:remote
npm run deploy
```

The native rate-limit binding must be available without enabling a paid add-on. If the account rejects it, resolve free-plan support before deployment; do not bypass abuse protection. Remote resources and a live deployment are not created by `npm run check`.

To verify a deployment, set `BASE_URL` to its actual HTTPS URL and run `npm run test:e2e`. This creates synthetic test reports and deletes them. Run only against your own deployment. Wait at least a minute between repeated live runs so the shared-IP write limiter can recover.

Workers Free permits 100,000 API requests/day and 10 ms CPU/request. D1 includes 5 million rows read/day, 100,000 rows written/day, and 500 MB per Free database. Static-asset requests are free. Application limits bound stored traces to roughly 125 MiB before index/row overhead; traffic can still exhaust daily quotas. Availability and limits can change. See [Operations](docs/OPERATIONS.md) for verified sources, retention, backups, rollback, and recovery procedures.

## Acceptance criteria and evidence

The release is evaluated against these checks:

1. Paired fixtures distinguish authorization and state failures without blocking matching permitted actions.
2. Labels change metrics, never policy decisions; future events cannot authorize earlier proposals.
3. Invalid, oversized, contradictory, or misordered imports produce actionable validation errors.
4. A saved trace survives a browser reload; a second session cannot list, read or delete it.
5. Cross-origin writes, capacity overflow, expired reports and service failures fail safely.
6. Export/import preserves trace content and reproduces deterministic decisions.
7. Critical journeys work at desktop and 390 px mobile widths without page overflow.
8. Automated accessibility checks report no serious or critical violations; primary controls support keyboard access.
9. Production assets total under 250 KiB gzip; bounded evaluation has a local performance regression test. Measured local figures are not cloud CPU guarantees.

Actual execution results, remaining gaps and deployment status belong in [Verification](docs/VERIFICATION.md); these criteria alone are not proof that they passed.

See [Trace format](docs/TRACE_FORMAT.md) to adapt logs and [Threat model](docs/THREAT_MODEL.md) for the explicit trust boundary. Coverage, provenance and reference labels in imported files are uploader assertions. This application does not authenticate their real-world truth or certify agent safety.
