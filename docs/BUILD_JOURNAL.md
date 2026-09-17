# Build journal

This records how Agent Control Lab was built, why its main choices were made, and the evidence available at each stage. Entries 1–8 reconstruct completed work from Git history, source files, test records and existing documentation. They are not a contemporaneous transcript or a recording of every development action. Entry 9 begins the ongoing deployment record.

Dates below are 2026-09-17 unless an entry says otherwise. Test counts and results belong to the named revision; later changes require their own verification. Authentication screens, credentials, cookies, private account details and database contents are excluded from this journal and its recordings.

## 1. Define the product and its limits

**Purpose:** make authorization failures in recorded agent workflows understandable through concrete evidence.

The application accepts a bounded JSON history containing approvals, revocations, resource changes, action proposals and dispatch results. It compares two policies: a static scope check and a policy that reconstructs authorization and resource state at each proposal. Decisions explain which events support an allow, block, review or unsupported outcome.

The first release supports `publish_artifact`. It includes eight authored examples pairing forbidden actions with matching permissible actions. These are educational fixtures, not measurements of a live model. Imported reference labels influence reported metrics but never the policy decisions. Partial histories and unsupported actions remain visible rather than becoming invented safety conclusions.

This boundary keeps the first release reproducible and usable without model keys, external tool credentials or paid inference. The application audits supplied records; it neither executes an agent's tools nor enforces authorization at dispatch. A trace digest detects content changes, not the truth of its provenance.

**Record:** initial application commit [`bc97304`](https://github.com/rahul-singh-au9/agent-control-lab/commit/bc97304), [Trace format](TRACE_FORMAT.md) and [Threat model](THREAT_MODEL.md).

## 2. Choose and connect the full-stack architecture

```text
Browser: React + TypeScript
  ├─ import → shared validation → deterministic evaluation → inspect/export
  └─ explicit save → same-origin Worker API → owner-scoped D1 records
```

| Choice                           | Reason                                                                                       | Implementation                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| React and TypeScript             | Build an interactive workspace with typed data flowing between its views.                    | `src/ui`, `src/main.tsx`                         |
| Shared schema and pure evaluator | Keep browser and server validation consistent; make policy decisions independently testable. | `src/core`                                       |
| Vite static build                | Deliver the frontend as small static assets without a separate frontend server.              | `vite.config.ts`, `dist` build output            |
| Cloudflare Worker                | Serve the API alongside the assets, preserving a same-origin request boundary.               | `worker/index.ts`, `wrangler.jsonc`              |
| D1 and versioned SQL migrations  | Persist reports with owner-scoped queries, indexes and atomic capacity controls.             | `migrations/0001_reports.sql`                    |
| Anonymous browser credential     | Allow private saved workspaces without an email/password service.                            | Session API and server-derived owner identifiers |

Evaluation and export run before any explicit save, so a storage outage does not prevent inspection. Saved reports use a real database; browser localStorage is not the report store. The anonymous cookie provides access, not verified human identity. Losing it loses access to that saved workspace, while exported reports can be imported again.

**Record:** `bc97304` established the application, API, migration and verification setup; subsequent commits hardened these boundaries. See the [README](../README.md) for the current architecture and startup commands.

## 3. Implement validation and policy evaluation

1. Define strict allowed fields and event types, with limits on bytes, events, strings and identifiers.
2. Validate event sequence, timestamps, references and resource-version consistency before evaluation.
3. Evaluate each proposal from its preceding recorded history. Later approvals cannot authorize earlier proposals.
4. Track grant scope, revocation, expiry, resource bindings and previous dispatch use for the current-state policy.
5. Attach reason codes and evidence event identifiers to each result.
6. Calculate labelled metrics with explicit numerators, denominators and coverage. Missing eligible labels produce no fabricated rate.
7. Recompute imported reports from the validated trace instead of trusting uploaded evaluation results.

The supported input remains bounded at 64 KiB and 200 events. A simple deterministic implementation was retained because measured behavior at that bound was fast and easier to inspect than a more complex execution system.

**Record:** `src/core/schema.ts`, `src/core/evaluate.ts`, `src/core/fixtures.ts`, `src/core/core.test.ts`; initial work in `bc97304` and validation/evaluation hardening in [`a29231c`](https://github.com/rahul-singh-au9/agent-control-lab/commit/a29231c).

## 4. Implement the inspection and report workflows

1. Build the fixture navigation and trace import views.
2. Display both policies, action decisions, source evidence, raw proposals and the event log.
3. Add comparison views so the same history can explain differences between policies.
4. Add JSON bundle export/import, including normalized trace SHA-256 verification when supplied.
5. Connect the saved-report library to the API: save, list, open, reevaluate, export and delete.
6. Keep local inspection/export available during API failures; expose actionable errors instead of false success.
7. Add mobile navigation, responsive long-text handling and keyboard focus management.

Later hardening rejects malformed UTF-8 files and inconsistent bundle metadata, validates successful API responses, and prevents late file reads, imports, report opens or library refreshes from overwriting newer user actions.

**Record:** `src/ui/App.tsx`, `src/ui/api.ts`, `src/ui/bundle.ts`, `src/styles.css`; `bc97304` and `a29231c`.

## 5. Implement persistence, isolation and retention

The migration creates `reports` and a singleton `capacity` table. Indexes support owner/date listings and expiry cleanup. Insert/delete triggers keep the global report counter synchronized with rows, including during cleanup.

The Worker validates requests again, derives ownership from a cryptographically random browser credential, and uses bound SQL parameters. Reads and deletions require both the report ID and the matching owner. Expired reports are filtered immediately, with daily cleanup configured for 03:17 UTC.

Storage limits are 20 reports per browser workspace, 2,000 reports globally and 30-day retention. Admission is atomic at both capacity boundaries. A native write limiter is configured for ten calls per minute per IP at a Cloudflare location. It is approximate and does not replace database caps or guarantee availability against distributed abuse.

Cross-tab session initialization was coordinated using Web Locks, with a bounded acquisition wait and request timeout. Browsers without that API retain same-page request coalescing. A save with an uncertain network outcome is not retried automatically because the database may already have committed it.

**Record:** `worker/index.ts`, `worker/index.test.ts`, `migrations/0001_reports.sql`, `src/ui/api.ts`; session coordination commit [`ca273eb`](https://github.com/rahul-singh-au9/agent-control-lab/commit/ca273eb) and further hardening in `a29231c`.

## 6. Review engineering and security boundaries

Review led to concrete corrections rather than a blanket claim that the application has no vulnerabilities:

- Reject timestamp precision that JavaScript would otherwise silently truncate.
- Bound streamed request bodies and session payloads; handle malformed JSON, invalid UTF-8 and excessive nesting safely.
- Enforce same-origin mutations, allowed methods and owner isolation; return generic errors for corrupt stored content.
- Set production cookie protections and restrictive browser response headers; render imported strings as text.
- Prevent stale asynchronous UI work and bound requests and session locks.
- Correct mobile overflow, keyboard focus trapping/restoration and resize behavior.
- Report scheduled cleanup as database changes because trigger updates affect the provider's mutation count.
- Add strict typed linting, React hook rules, formatting, pinned dependencies and dependency update configuration.

TypeScript 6.0.3 was kept within the selected lint parser's supported range. Hosted workflow permissions are read-only, and its action revisions are pinned. The evaluator does not fetch imported URLs, run supplied code or call external models.

**Record:** `a29231c` and [Engineering review](ENGINEERING_REVIEW.md). [Threat model](THREAT_MODEL.md) records residual risks, including anonymous quota consumption, credential loss and uploader-asserted trace provenance.

## 7. Verify functionality, recovery and recordings

At application revision `a29231c`, the local verification record reports:

| Check                                     | Recorded result                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Unit/API/client/import tests              | 125 passed: 41 core, 43 API and 41 client/import                                       |
| Browser journeys                          | 39 passed: 13 each in Chromium, Firefox and WebKit                                     |
| Lint, formatting, strict typing and build | Passed                                                                                 |
| Dependency audit                          | Zero reported vulnerabilities at the time of checking                                  |
| Selected module coverage                  | 98.96% lines; excludes React components, fixtures, tests and scripts                   |
| Maximum-size trace evaluation             | Local median 0.569 ms; not a cloud CPU guarantee                                       |
| Production JavaScript/CSS                 | 115,385 bytes gzip                                                                     |
| Recovery rehearsal                        | Migration, SQL backup/restore, counter invariants and scheduled cleanup passed locally |

Browser verification includes actual local Worker/D1 save/reload/open/export/delete and cross-session isolation. Other journeys deliberately stub responses to isolate UI failures, races and recovery. Manual browser review checked decisions, evidence, comparisons, malformed input, focus restoration and mobile layout. Automated accessibility checks found no serious or critical violations in the tested views; they do not constitute full screen-reader or physical-device certification.

The recovery rehearsal uses isolated databases. It verifies schema/index/trigger/migration preservation, insert/delete counter changes, expired-row cleanup, a repeat cleanup with no unintended deletion, and unchanged source records.

Two local walkthroughs were recorded: approximately 2 minutes 11 seconds on desktop and 34 seconds on mobile. They show functioning workflows with synthetic traces. The storage-failure chapter explicitly injects HTTP 503 responses; save/reload/delete use the real local backend. MP4 encoding, complete decoding, frame review and playback/seeking were checked. These videos demonstrate functionality; they do not reconstruct the earlier development process or show a public deployment.

**Record:** [Verification](VERIFICATION.md), `tests/journeys.spec.ts`, `scripts/recovery-rehearsal.mjs`, `scripts/record-walkthrough.mjs`, `scripts/prepare-walkthrough.mjs` and `scripts/serve-walkthrough.mjs`. Local video and recovery outputs are retained under the ignored `.artifacts` directory, not published with the source.

## 8. Publish source and run hosted verification

The repository was published at [rahul-singh-au9/agent-control-lab](https://github.com/rahul-singh-au9/agent-control-lab). Existing Git history was preserved.

| Revision  | Recorded change                                               | Hosted evidence                                                                                          |
| --------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `bc97304` | Build authorization trace auditing workbench                  | Initial source history                                                                                   |
| `ca273eb` | Coordinate browser session initialization and verify recovery | Follow-up source history                                                                                 |
| `a29231c` | Harden trace validation, storage and review workflows         | [Passing run 35198170813](https://github.com/rahul-singh-au9/agent-control-lab/actions/runs/35198170813) |
| `967c0cd` | Document public repository and hosted verification            | [Passing run 35198513232](https://github.com/rahul-singh-au9/agent-control-lab/actions/runs/35198513232) |

The latest listed run used revision `967c0cd35976d89743b767c6f7f3bbe71263c27a` and completed successfully on 2026-09-17 at 08:16 UTC. It installed locked dependencies and ran checks, dependency audit and all three browser projects on Linux. These used local Worker/D1 bindings on the runner, not a remote database.

**Record:** `.github/workflows/verify.yml` and the linked run logs. Repository publication and successful CI are separate from application deployment.

## 9. Connect Cloudflare, create D1 and prepare deployment

The owner signed in and authorized the Wrangler access grant. The account dashboard confirmed Workers Free at $0; no paid plan was activated. The account initially showed no projects, and the D1 listing was empty. Credentials and the authorization interaction are deliberately absent from this journal.

The remote `agent-control-lab` D1 database was then created with the APAC location hint. The initial `0001_reports.sql` migration completed successfully with eight commands. This establishes the remote persistence resource; it is separate from publishing the application.

A deployment review also found that malformed input could contain 12,000 null array items within the byte cap and consume avoidable validation work. Early array bounds were added for events, labels and evidence references, with three regression tests. All 128 unit/API/client/import tests passed, including 44 core tests, together with lint, formatting, TypeScript and production build. A local parse measurement changed from approximately 5.1–11.4 ms to 0.105–0.283 ms for that input; these are local observations, not a cloud CPU guarantee.

Production resource IDs were recorded in configuration. A separate local preview database identity preserves the existing local database when the remote ID changes. The resulting code and configuration are recorded in [revision f52f2c9](https://github.com/rahul-singh-au9/agent-control-lab/commit/f52f2c919087a9dcc8c3e104e1d9432db1e6c5e9).

The deployment sequence is:

1. Create the remote D1 database and record its non-secret identifier in the Worker configuration. Database creation completed.
2. Apply the reviewed migration and check the expected tables, indexes and triggers. Initial migration completed; remote schema verification belongs in the release evidence.
3. Deploy the production assets and Worker with the D1 and rate-limit bindings under the verified Free plan.
4. Record the actual HTTPS URL and deployed version.
5. Verify the live health endpoint, response headers, secure session behavior, persistence and isolation.
6. Run public-site browser projects sequentially with at least a minute between projects to respect the shared-IP write limit. Remove only the synthetic reports created by verification.
7. Check scheduling and provider usage evidence, distinguishing configuration from an observed remote cleanup execution.
8. Update release documentation with the results and any unresolved limitations.

## 10. Deploy and verify the public application — 2026-09-17

The first public version, `14cf4662-4576-47b9-b930-f5e88de7e508`, was deployed at 08:28 UTC to [Agent Control Lab](https://agent-control-lab.rahulsg1508.workers.dev). Deployment inspection confirmed the actual remote D1 binding, static assets, native ten-write-per-minute limiter and daily 03:17 UTC schedule. The account remained on Workers Free.

All 39 live browser checks passed without retries: Chromium 13/13 in 22.2 seconds, Firefox 13/13 in 26.2 seconds and WebKit 13/13 in 24.2 seconds. The real-storage journey in each engine saves, reloads, reads and deletes against the actual remote D1 database, and checks another session cannot read or delete the report. Other journeys explicitly mock storage when isolating error or UI behavior. Manual Safari review also confirmed the live revoked-grant example, policy comparison and supporting evidence.

Additional live API checks verified static security headers, database health, anonymous 401 responses, unknown-route 404, unsupported-method 405, cross-origin 403 and secure session cookies. Three maximum-size traces (65,536 bytes and 200 events each) saved, loaded and were deleted. A bounded limiter probe returned 429 on its twelfth request, consistent with an approximate limiter; requests recovered after the cooldown. The 12,000-item malformed trace then returned 400 and created no report.

The actual scheduled handler was verified using two identified synthetic rows. A temporary every-minute schedule removed the expired row and retained the unexpired row. The original daily schedule was restored at 08:38 UTC, and both identified test rows were absent after cleanup. No other records were deleted by the verification script.

Live event CPU measurements exposed a performance issue despite successful HTTP responses: initial maximum-trace saves used 24 and 27 ms, and reads used 28 and 11 ms, above the Free plan's 10 ms request budget. Later requests used 8 ms for save and 4 ms for read. This was consistent with first-use validation overhead, not evidence that the resource budget passed. It prompted the targeted initialization change and measurements recorded in entry 11.

Sanitized response summaries, browser reports and retention evidence are stored locally under `.artifacts/live-verification-2026-09-17/`. They exclude authentication cookies and raw request headers. Public documentation reports conclusions; the evidence directory remains outside Git.

## 11. Reduce first-request validation work and preserve input boundaries

The first live maximum-payload measurements revealed CPU overhead that local elapsed-time tests had not established. A deterministic initialization trace was added to exercise every event variant, collection and timeline path during Worker startup. It contains synthetic constants only, performs no I/O or runtime code generation, and retains no parsed result or user data.

One initialization pass reduced some request costs but still produced saves at 13, 10 and 12 ms and reads at 19, 7 and 4 ms. An independent cold-process measurement compared 1, 5, 10 and 20 passes. Ten captured most of the observed benefit; twenty added initialization cost with little improvement. The final implementation therefore constructs one bounded seed and parses it ten times. Reported deployed startup increased from 23 to 48 ms, within the provider's one-second startup limit. Local measurements remain diagnostic, not proof of remote request performance.

The save path also performed an unnecessary extra JSON serialization and UTF-8 size check before calling the shared validator, which already performs that check. That duplicate pass was removed. A typed size error preserves HTTP 413, and the separate normalized stored-size boundary remains enforced.

A regression demonstrates why normalized-size checking cannot be removed: scientific-notation numbers can fit inside the incoming byte limit but expand when serialized. The new case correctly rejects a 65,537-byte normalized trace with 413 and stores no record. Deeply nested invalid input continues to return 400, and corrupt stored traces continue to return a generic 503.

After these changes, all 130 unit/API/client/import tests passed: 45 core, 44 API and 41 client/import. Lint, formatting, strict TypeScript and the production build passed; the dependency audit reported zero known vulnerabilities at that time. Instrumented coverage of the selected modules was 99.26% lines, 98.68% statements, 96.26% branches and 100% functions. These figures exclude React components, fixtures, tests and scripts and do not prove the absence of vulnerabilities.

The final deployed version `93577878-2708-4202-8e9b-1620b5edd5b7` passed three maximum-size save/read cycles at 08:48 UTC. Provider CPU was 8, 4 and 7 ms for saves and 5, 4 and 6 ms for reads. All six responses succeeded without reported execution exceptions, and all three identified synthetic reports were deleted. These samples fit the 10 ms allowance; they are not a guarantee for every isolate, region or future input.

After the final deployment, all 13 Chromium browser journeys passed again against the public site without retries in 21.7 seconds. This repeated the real remote persistence and isolation workflow as well as the UI/error checks. The live API smoke suite also passed again. The final application assets measured 115,524 gzip bytes. Release documentation now distinguishes completed live checks, historical measurements and remaining limits, and the README links this journal for continued updates.

**Record:** `src/core/schema.ts`, `worker/index.ts`, their regression tests and [Verification](VERIFICATION.md). Remote measurements are recorded separately from successful HTTP status codes.

## Reproduce the development checks

Use the Node version in `.nvmrc`, then run these commands from the repository root:

```sh
npm ci
npm run build
npm run db:migrate:local
npm run preview
```

Open `http://127.0.0.1:8787`. In another terminal:

```sh
npm run check
npm run audit:dependencies
npx playwright install chromium firefox webkit
npm run test:e2e
npm run test:coverage
node scripts/recovery-rehearsal.mjs
```

With the local preview running, capture the synthetic walkthrough with `npm run record:walkthrough`. With FFmpeg available, `node scripts/prepare-walkthrough.mjs` prepares the MP4 files and chapter player; `npm run preview:walkthrough` serves that player locally. See [Verification](VERIFICATION.md) for the optional encoder-path configuration.

Remote setup changes the selected Cloudflare account. After verifying that account, its Free plan and the configuration, the deployment commands are:

```sh
npx wrangler whoami
npx wrangler d1 create agent-control-lab
# Set the returned database_id in wrangler.jsonc before continuing.
npm run db:migrate:remote
npm run deploy
```

Do not repeat database creation for an existing deployment. Use the [Operations](OPERATIONS.md) procedures for migrations, backups, rollback and recovery. Do not upgrade a plan to resolve a deployment or quota error.

## How this record will continue

Append a dated entry for each material change or release. Record the user-visible purpose, files or components changed, why the choice was made, the revision or deployment version, commands/checks actually run, observed results and any remaining work. Keep earlier results attached to their original revisions instead of silently presenting them as evidence for newer code.

Link additional functional recordings when workflows change. Preserve credentials, account pages, cookies and user trace contents outside recordings and published evidence. Unrecorded earlier actions must stay identified as reconstruction; pending work must not be relabelled complete until verified.
