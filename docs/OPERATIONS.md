# Operations

This application audits recorded artifact-publication proposals against deterministic policies. The browser reconstructs the factual event history in memory and compares policy decisions; an optional same-origin Worker stores reports in D1. It does not simulate action effects, call a model provider, execute imported code, or connect to the systems named in a trace. There is no localStorage report database; export the current trace or explicitly save it to the server before leaving the page.

## Keep the deployment free

The supported deployment uses a Cloudflare **Workers Free** account, static assets, and one D1 database. Use the included `workers.dev` address. No paid model, purchased domain, R2 bucket, paid add-on, or external telemetry service is required. Do not upgrade the account or enter payment information to resolve a limit. Local evaluation and JSON export remain the fallback when storage is unavailable.

An existing account can already be on Workers Paid. Check the account's plan before creating resources; deploying this code does not establish that its account is free. Cloudflare advertises [Workers signup without a credit card](https://www.cloudflare.com/products/workers/). Free services can change or end under the [provider's terms](https://www.cloudflare.com/terms/); this is a current free-plan design, not a promise of permanent free hosting. No personal-only or noncommercial-only restriction was found in the reviewed Workers Free pricing and terms. Normal acceptable-use restrictions still apply.

Provider limits checked on 2026-09-17:

| Resource      | Free-plan allowance relevant to this application                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker API    | 100,000 requests per day and 10 ms CPU per invocation; network wait is distinct from CPU time. [Pricing](https://developers.cloudflare.com/workers/platform/pricing/)                                                                                              |
| Static assets | Asset requests and storage are free. Keep `/api/*` as the Worker-first route so ordinary application assets do not invoke API code. [Billing and routing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)                        |
| D1 operations | 5 million rows read and 100,000 rows written per day; reads measure rows scanned. Daily limits reset at 00:00 UTC. Queries fail at the free cap; they do not automatically switch to paid usage. [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 storage    | 500 MB per database, 5 GB per account, 10 databases, and seven days of Time Travel recovery. [Limits](https://developers.cloudflare.com/d1/platform/limits/)                                                                                                       |

Limits are shared with other workloads on the account. A stored-report cap does not cap requests, scanned rows, or total write churn. Review these allowances again before a deployment or a substantial traffic increase.

No timed inactivity suspension was found in the reviewed Workers/D1 documentation. Workers use [quickly initialized isolates](https://developers.cloudflare.com/workers/reference/how-workers-works/); this does not guarantee zero startup or database latency. Free service availability is not an application uptime guarantee.

## Application capacity and retention

The service targets these limits independently of provider quotas:

- 20 saved reports per anonymous browser session.
- 64 KiB maximum trace payload, measured as UTF-8 bytes at the API boundary.
- 2,000 reports across the deployment: at most approximately 125 MiB of trace payload before database/index overhead.
- Reports expire 30 days after creation. Reads must exclude expired records immediately; a daily cleanup removes their database rows.
- The scheduled cleanup runs at 03:17 UTC according to `wrangler.jsonc`. Failed or delayed cleanup can leave expired rows physically stored until a successful later run.

Insertion must enforce capacity atomically. The database counter and report rows must remain consistent through inserts, deletes, and retention cleanup. Do not solve capacity exhaustion by deleting unexpired reports belonging to other visitors. Return a clear storage-unavailable/capacity response and preserve local export.

## Anonymous access and recovery

The session cookie is the credential for saved reports. The intended production cookie has 32 random bytes, `HttpOnly`, `Secure`, and `SameSite=Strict`; D1 stores a derived owner identifier rather than the raw cookie. Reports are scoped to that owner for every read and deletion.

Clearing cookies, changing browsers, or losing the device loses access to that session's reports. There is no email login, password reset, identity verification, or account-recovery service. JSON export/import restores report content into a new session; it does not restore the old credential or unlock old server records. Export useful reports before clearing site data. Exported files are readable data and should be handled accordingly.

Session creation requires an empty JSON object within 1 KiB. Modern browsers serialize first-time session initialization across tabs using Web Locks, with a 30-second acquisition deadline; requests have a 12-second deadline. Browsers without Web Locks retain same-page coalescing. Saves are not idempotent: if a response is lost after commit, refresh the library before retrying to avoid an extra copy.

Validate and redact traces before saving. Schema validation is not secret detection or personal-data redaction. Use synthetic or deliberately sanitized examples for a public demonstration. Cloudflare and the deployment operator can administer the database; these reports are not end-to-end encrypted.

## Rate limiting

Cloudflare's native [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) uses `ratelimits` in Wrangler 4.36 or later. A ten-call minute is `simple: { "limit": 10, "period": 60 }`; `namespace_id` is a unique positive integer represented as a string. Call the binding before database mutations and return 429 with a retry interval when it rejects a request.

Counters are approximate, eventually consistent, and local to a Cloudflare location. They cannot enforce an exact global storage or spending budget. An IP limit may affect unrelated people behind a shared network, while a session-only limit can be bypassed by minting new sessions. Production must not silently bypass protection when a required binding is missing or fails.

The reviewed native-binding documentation does not publish a separate price or explicitly establish a Free-plan entitlement. Do not infer entitlement from its example of an application's “free users.” Confirm availability without activating a paid feature before making this binding a deployment dependency. A rejected deployment is preferable to a paid upgrade.

Cloudflare documents [local simulation support](https://developers.cloudflare.com/workers/local-development/bindings-per-env/) for both D1 and rate limiting. Test against local bindings. A deterministic test double is suitable for testing the 429 branch, but it does not demonstrate distributed rate-limit accuracy.

## Local verification and deployment

Use the Node version specified by `.nvmrc` and install the locked dependencies. The repository's scripts provide the following workflow:

```sh
npm ci
npm run db:migrate:local
npm run check
npm run test:e2e
npm run audit:dependencies
```

Run `npm run preview` to serve the production build with local Worker/D1 bindings. It uses `--local`; no production database should be involved in local tests. A development server is not a deployment.

For an authorized deployment, select a verified Workers Free account, create a D1 database named `agent-control-lab`, and replace the all-zero `database_id` in `wrangler.jsonc` with its identifier. Apply remote migrations with `npm run db:migrate:remote`, then deploy with `npm run deploy`. These commands mutate the selected Cloudflare account and database. Review the account identifier and migration before running them.

After deployment, verify HTTPS cookie flags, two-browser report isolation, disallowed cross-origin mutations, payload and report limits, 404 behavior for another session's report, rate-limit responses, and cleanup scheduling. Confirm that errors never mark a report as saved and that local evaluation/export still work when the API is unavailable. Do not load-test a live free account to its provider limit.

## Monitoring and incidents

Use the provider's existing request/error and D1 usage views. Never log session cookies, trace bodies, tool arguments, personal data, or exported reports. Log only operational identifiers and non-sensitive error categories. Sampling does not make sensitive logging acceptable.

Cleanup completion logs report `databaseChanges`, which includes trigger mutations in D1. Do not interpret this as the number of deleted report rows. Known API paths reject unsupported methods with 405 and an Allow header; unknown paths return 404. Private responses are noncacheable and carry same-origin resource policy headers.

For repeated 429 responses, wait for the interval rather than looping retries. For capacity or provider-limit failures, keep the browser evaluator available and investigate usage. For an authorization defect, disable report access first, preserve only the operational evidence needed to diagnose it, and fix the defect before reopening storage.

Time Travel is an operator recovery tool, not a user recovery promise. Restoring a database can resurrect deleted or expired rows; rerun retention cleanup and assess deleted-data handling before reopening restored storage. Retention describes application access and cleanup, not immediate erasure from provider recovery history.

## Backup and rollback procedures

The commands below were checked against the installed Wrangler help and the linked provider documentation. Replace uppercase placeholders before execution. Remote commands operate on the account selected by Wrangler; confirm the account, database, and intended recovery point first. SQL backups contain every stored trace and owner identifier, so keep them outside the repository in a private directory and apply a deliberate backup-retention policy.

Before a migration, record the database bookmark and export the database:

```sh
npx wrangler d1 time-travel info agent-control-lab --json
npx wrangler d1 export agent-control-lab --remote --output "/ABSOLUTE/PRIVATE/BACKUP.sql"
```

[D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) writes SQL, not a raw SQLite binary. Export can temporarily block database requests. Check the exit code and file before relying on it. Avoid overwriting the only good backup.

For a bad application release, inspect previous versions and roll back to the selected known-good version:

```sh
npx wrangler versions list --name agent-control-lab --json
npx wrangler rollback "WORKER_VERSION_ID" --name agent-control-lab --message "Restore verified application version"
```

A [Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) does not roll back D1 data or schema. Verify that the selected code supports the current schema before routing traffic to it. Run the report-isolation and save/load checks after rollback.

For database damage, first stop writes or take report storage offline. Capture the current bookmark and a private export if possible. Find the intended recovery bookmark within the **seven-day Free-plan window**:

```sh
npx wrangler d1 time-travel info agent-control-lab --timestamp "RFC3339_UTC_RECOVERY_TIME" --json
npx wrangler d1 time-travel restore agent-control-lab --bookmark "BOOKMARK_FROM_INFO"
```

[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is already enabled and recovery has no additional charge. Restore overwrites the remote database and cancels in-flight queries. Preserve the previous bookmark returned by the restore in case the selected point is wrong. Do not infer a 30-day allowance from generic CLI help: Workers Free permits seven days.

For an SQL backup, first rehearse the import into a new empty local persistence directory:

```sh
npx wrangler d1 execute agent-control-lab --local --persist-to "/ABSOLUTE/EMPTY/RECOVERY_DIR" --file "/ABSOLUTE/PRIVATE/BACKUP.sql"
npx wrangler d1 execute agent-control-lab --local --persist-to "/ABSOLUTE/EMPTY/RECOVERY_DIR" --command "SELECT (SELECT COUNT(*) FROM reports) AS actual_reports, (SELECT report_count FROM capacity WHERE id = 1) AS recorded_reports;"
```

Inspect the restored schema, indexes, and both counter triggers. A backup import is not a merge: do not run its schema/data statements blindly over an occupied database. If remote import is required, provision an empty recovery database within the same Free account's existing allowance, reference its name and identifier in a separate reviewed Wrangler configuration, then use:

```sh
npx wrangler d1 execute RECOVERY_DATABASE_NAME --config "/ABSOLUTE/PRIVATE/RECOVERY_CONFIG.jsonc" --remote --file "/ABSOLUTE/PRIVATE/BACKUP.sql"
```

Before switching the application's binding, verify the count invariant, retain or restore the expected migration history, remove expired records, and run isolation checks using synthetic reports. If restoring deleted content cannot be reconciled with its intended retention, keep the recovered service offline. A recovery database is an additional Free-plan resource, not an instruction to upgrade or exceed quotas.
