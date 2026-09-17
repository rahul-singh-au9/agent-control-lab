# Verification record

Date: 2026-09-17. Scope: local and public deployment checks, macOS ARM64, Node 24.21.0, Worker/D1/native limiter, Chromium 153, Firefox 155 and WebKit 26.6. Browser versions come from the installed test runtime; this is not a physical-device certification.

**Published and deployed:** [Agent Control Lab](https://agent-control-lab.rahulsg1508.workers.dev), with public source at [rahul-singh-au9/agent-control-lab](https://github.com/rahul-singh-au9/agent-control-lab). The account dashboard confirmed Workers Free ($0). Remote D1 creation, migration, asset/API deployment and native rate-limit binding succeeded without a paid upgrade. Functional checks passed; maximum-payload CPU measurements and remaining limits are recorded below.

[Hosted verification run](https://github.com/rahul-singh-au9/agent-control-lab/actions/runs/35200631988) passed for application commit `f52f2c9`: lint, formatting, TypeScript, production build, **128 unit/API/client/import tests**, dependency audit, and **39 browser checks** across Chromium, Firefox and WebKit. Hosted checks use isolated local Worker/D1 bindings on the runner. Separate public-site checks below exercise the real deployment.

## Executed checks

| Check                                         | Result                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Typed linting and React hook rules            | Passed, zero warnings                                            |
| Formatting check                              | Passed                                                           |
| Strict TypeScript and production build        | Passed                                                           |
| Unit/API/client/import tests                  | 130 passed: 45 core, 44 API, 41 client/import                    |
| Browser suite                                 | 39 passed: 13 journeys in each of Chromium, Firefox and WebKit   |
| Dependency audit                              | Zero reported vulnerabilities at the time of checking            |
| Local migration and actual persistence        | Passed                                                           |
| Isolated backup/restore and scheduled cleanup | Passed                                                           |
| Worker deployment                             | Public HTTPS deployment with D1, assets, limiter and cron passed |
| Desktop/mobile walkthrough recordings         | Completed without browser runtime errors                         |

The recorded local browser run passed with no retry in 48.6 seconds. Earlier added checks contained incorrect selectors/expectations for the delete-cancel label, event-log disclosure and empty coverage denominator; those tests were corrected to the interface and metric contract before the passing run. Application defects were fixed with regressions.

## Flow and edge-case evidence

| Area              | Verified behavior                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policies/timeline | All eight paired fixtures; scope, revocation, exact expiry, content state, partial coverage, dispatch use and failed results; no future-event or reference-label leakage.                                         |
| Trace validation  | Duplicate IDs, unsafe sequence numbers, invalid references, contradictory versions, invalid timestamps/precision, unknown fields, deep nesting, byte/event boundaries and malformed UTF-8.                        |
| Inspection        | Both policies, action selection, evidence, raw proposals, full log, comparisons, unsupported tools and empty eligible-label denominators.                                                                         |
| Import/export     | Text/files, normalized SHA-256, tampered bundles, unsupported metadata, malformed JSON, oversized files, invalid-byte recovery, inert hostile text and ignored uploaded evaluations.                              |
| Real persistence  | Two tabs starting together create one credential. Save, reload, open, reevaluate, library export, cancel deletion and delete use actual local and remote bindings. Another browser cannot read/delete a known ID. |
| UI races          | Late opens cannot replace newer selections; stale refreshes cannot erase a successful save; cancelled digest verification cannot import later. Request and lock deadlines have unit coverage.                     |
| Failures          | Malformed successful responses, 503 errors and 429 retry metadata remain recoverable. Failed saves never become saved success. Local evaluation/export remain usable.                                             |
| API protection    | Cookie separation, ambiguous cookies, origin/fetch metadata, streamed body limits, routes/methods, owner/global capacity races, retention, missing bindings, corrupt stored content and generic logs.             |
| Keyboard/mobile   | Dialog focus return, navigation Tab wrap/Escape, navigation focus and resize recovery. Long titles/identifiers/tool names fit a 320 px viewport.                                                                  |
| Accessibility     | No serious/critical axe WCAG 2 A/AA or 2.1 AA findings in tested desktop/mobile audit, comparison, method, library and import views across three engines.                                                         |

The first browser journey uses real Worker/D1 storage, locally or remotely according to its configured base URL. Other browser tests explicitly stub responses to isolate UI behavior or inject failures. API tests execute actual migrations, SQL and triggers through a SQLite adapter. The recovery rehearsal separately exercises actual local D1 and scheduled Worker bindings.

Hands-on review in the in-app browser checked evaluation, differing static/stateful revoked-approval decisions, expanded evidence, comparison, malformed input, cancellation/focus return, example download, mobile fixture navigation and visual wrapping. Automated journeys supply broader repeatable coverage. This is not an independent penetration test or comprehensive screen-reader study.

## Coverage and local performance

Instrumented schema, evaluator, storage client, import parser and Worker coverage: **99.26% lines, 98.68% statements, 96.26% branches and 100% functions**. React components, fixtures, tests and scripts are excluded from these percentages. UI correctness is checked through browser tests and review. Execution coverage does not prove security or correctness.

- A **65,536-byte, 200-event trace with 80 proposals** evaluated in a median **0.568 ms** across 15 uninstrumented measurements; the regression threshold is 100 ms. Instrumented median: 1.320 ms.
- Application JavaScript/CSS totals **115,524 bytes gzip**, below 250 KiB.
- Local usability smoke checks completed in **580 ms Chromium, 595 ms Firefox and 583 ms WebKit**, including a 500 ms network-idle observation. These are not Core Web Vitals or mobile-network results.
- The final deployed Worker packaged 786.69 KiB uncompressed / 124.89 KiB gzip, with 48 ms reported startup against a one-second startup limit. See remote CPU results below.

## Recovery rehearsal

`node scripts/recovery-rehearsal.mjs` creates isolated source/recovery databases under `.artifacts`, leaving preview and test databases untouched. SQL export/import preserves migration history, both indexes and both triggers. Insert/delete moves the restored counter **2 → 3 → 2**. Actual local scheduled cleanup removes only the expired row (**2 → 1**); a second invocation leaves the survivor unchanged. Source counts and content remain unchanged, local SQLite integrity checks pass, and the temporary server stops afterward.

Evidence: `.artifacts/recovery-2026-09-17T07-38-55-940Z/manifest.json`. The script records provider-specific details: local export uses isolated configurations because the command lacks `--persist-to`; scheduled test routing must precede SPA assets; integrity checks read only the isolated local SQLite file because D1 rejects the PRAGMA. Remote recovery is unverified.

## Recordings

`npm run record:walkthrough` captures continuous real browser interaction using synthetic examples. Desktop duration: approximately **2 minutes 11 seconds**. Mobile: approximately **34 seconds**. Chapter timings and completion/error records: `.artifacts/walkthrough/chapters.json`.

Desktop coverage includes all eight fixtures, evidence/log/raw inspection, comparisons, multiple actions/consumed grant allowance, unsupported tools, partial history, save/reload/open/export/delete, invalid JSON, digest rejection, file import, storage failure/recovery and method boundaries. Mobile covers navigation, evidence, comparison, import dismissal/focus and the library.

HTTP 503 responses are deliberately injected only in the failure demonstration. Save/reload/delete use the actual local backend. MP4 versions add a caption strip below the original viewport; original WebM files remain available. No audio, reconstructed UI or public-deployment footage. Both MP4 files passed complete decoding checks, visual frame inspection and Chromium playback/chapter seeking. One native video-control interaction crashed the in-app browser; use the downloaded MP4 in a normal media player if that viewer issue recurs. With FFmpeg installed, `FFMPEG_PATH=/absolute/path/to/ffmpeg node scripts/prepare-walkthrough.mjs` prepares MP4 files and the chapter player.

## Public deployment verification

The initial public version `14cf4662-4576-47b9-b930-f5e88de7e508` went live at 08:28 UTC. Deployment inspection confirmed the actual production D1 ID and daily 03:17 UTC trigger. The separate preview ID preserves local database identity; it is not the remote binding.

- **39 live browser checks passed without retries:** 13 Chromium (22.2 seconds), 13 Firefox (26.2 seconds) and 13 WebKit (24.2 seconds), with cooldowns between projects. The real-storage journey in each engine verified remote save/reload/open/export/delete, HTTPS cookie attributes and another session's denied access. Other journeys intentionally mock storage failures and UI edge cases.
- **Live API checks passed:** database health, static security headers, unauthenticated 401, unknown route 404, wrong method 405, same-origin protection 403 and secure session initialization.
- **Maximum payload:** three 65,536-byte, 200-event traces saved and loaded successfully, then were deleted. Only reports created by the verification script were removed.
- **Abuse and recovery:** a bounded probe observed 429 with Retry-After on request twelve; the approximate limiter does not promise rejection at exactly request eleven. After cooldown, requests recovered and a malformed 12,000-item trace returned 400 without creating a report.
- **Actual remote retention:** a temporary every-minute cron removed the identified expired synthetic row and retained the unexpired row. The daily schedule was restored at 08:38 UTC and the remaining synthetic row was deleted. This verifies an actual scheduled execution, not just configuration.
- **Manual Safari:** the public site initialized a workspace, evaluated the revoked-grant fixture, and displayed the policy comparison and supporting revocation evidence.

Sanitized results and browser reports are retained locally under `.artifacts/live-verification-2026-09-17/`. They exclude raw authentication headers and cookies. Browser usability observations were 1,049 ms Chromium, 1,116 ms Firefox and 1,281 ms WebKit, including a 500 ms network-idle wait; these are not Core Web Vitals.

## Resource limits and remaining verification

All initial maximum-payload requests returned successful HTTP responses, but provider CPU observations were **24, 27 and 8 ms for saves**, and **28, 11 and 4 ms for reads**. A subsequent one-time validation initialization during Worker startup reduced observations to **13, 10 and 12 ms for saves**, and **19, 7 and 4 ms for reads** (version `79a5832a-30b4-4a57-8ea3-b7f33876590a`, startup 23 ms). These samples do not establish compliance with the 10 ms Free CPU budget for every request.

The final implementation initializes the same bounded synthetic trace ten times during startup and removes one duplicate save-path serialization pass. Version **`93577878-2708-4202-8e9b-1620b5edd5b7`** reported **48 ms startup**. Three maximum-size saves then measured **8, 4 and 7 ms CPU**, with corresponding reads at **5, 4 and 6 ms**, all below 10 ms in these samples. All six responses succeeded, no execution exceptions were reported, and the three identified test reports were deleted. The full 64 KiB/200-event contract and all schema/timeline checks were retained. A regression also verifies 413 for compact numbers that expand beyond the limit during normalization.

After this final deployment, all 13 Chromium journeys passed again against the public URL without retries in 21.7 seconds, including the real D1 persistence/isolation journey. The live API smoke suite passed again. The asset measurement was 115,524 gzip bytes and the Chromium usability observation was 1,133 ms. The earlier three-engine results above belong to the initial deployment; hosted CI reruns all three engines for source changes using isolated local bindings.

Cloudflare allows occasional CPU bursts, but consistently exceeding the allowance can terminate execution. See [Worker resource limits](https://developers.cloudflare.com/workers/platform/limits/). These bounded samples are evidence for this deployment, not a guarantee across every isolate, region, input or future runtime. No paid upgrade was activated. Public high-concurrency behavior and remote database disaster recovery have not been demonstrated.

No claim is made that every possible input was tested or no vulnerabilities remain. The [Engineering review](ENGINEERING_REVIEW.md), [Threat model](THREAT_MODEL.md) and [Operations](OPERATIONS.md) describe anonymous quota consumption, cookie recovery, uncertain non-idempotent saves and unverified trace provenance.
