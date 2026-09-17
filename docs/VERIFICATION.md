# Verification record

Date: 2026-09-17. Scope: local release candidate on macOS ARM64, Node 24.21.0, local Worker/D1/native limiter, Chromium 153, Firefox 155 and WebKit 26.6. Browser versions come from the installed test runtime; this is not a physical-device certification.

**Locally verified; not deployed.** Cloudflare connection was deferred by the owner. The GitHub destination is `rahul-singh-au9`, awaiting write access. The remote database ID remains a placeholder. No public URL, remote database or hosted CI result is claimed.

## Executed checks

| Check                                         | Result                                                         |
| --------------------------------------------- | -------------------------------------------------------------- |
| Typed linting and React hook rules            | Passed, zero warnings                                          |
| Formatting check                              | Passed                                                         |
| Strict TypeScript and production build        | Passed                                                         |
| Unit/API/client/import tests                  | 125 passed: 41 core, 43 API, 41 client/import                  |
| Browser suite                                 | 39 passed: 13 journeys in each of Chromium, Firefox and WebKit |
| Dependency audit                              | Zero reported vulnerabilities at the time of checking          |
| Local migration and actual persistence        | Passed                                                         |
| Isolated backup/restore and scheduled cleanup | Passed                                                         |
| Worker deployment packaging                   | Dry run passed; no upload or cloud resources created           |
| Desktop/mobile walkthrough recordings         | Completed without browser runtime errors                       |

The final browser run passed with no retry in 48.6 seconds. Earlier added checks contained incorrect selectors/expectations for the delete-cancel label, event-log disclosure and empty coverage denominator; those tests were corrected to the interface and metric contract before the passing run. Application defects were fixed with regressions.

## Flow and edge-case evidence

| Area              | Verified behavior                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Policies/timeline | All eight paired fixtures; scope, revocation, exact expiry, content state, partial coverage, dispatch use and failed results; no future-event or reference-label leakage.                              |
| Trace validation  | Duplicate IDs, unsafe sequence numbers, invalid references, contradictory versions, invalid timestamps/precision, unknown fields, deep nesting, byte/event boundaries and malformed UTF-8.             |
| Inspection        | Both policies, action selection, evidence, raw proposals, full log, comparisons, unsupported tools and empty eligible-label denominators.                                                              |
| Import/export     | Text/files, normalized SHA-256, tampered bundles, unsupported metadata, malformed JSON, oversized files, invalid-byte recovery, inert hostile text and ignored uploaded evaluations.                   |
| Real persistence  | Two tabs starting together create one credential. Save, reload, open, reevaluate, library export, cancel deletion and delete use actual local bindings. Another browser cannot read/delete a known ID. |
| UI races          | Late opens cannot replace newer selections; stale refreshes cannot erase a successful save; cancelled digest verification cannot import later. Request and lock deadlines have unit coverage.          |
| Failures          | Malformed successful responses, 503 errors and 429 retry metadata remain recoverable. Failed saves never become saved success. Local evaluation/export remain usable.                                  |
| API protection    | Cookie separation, ambiguous cookies, origin/fetch metadata, streamed body limits, routes/methods, owner/global capacity races, retention, missing bindings, corrupt stored content and generic logs.  |
| Keyboard/mobile   | Dialog focus return, navigation Tab wrap/Escape, navigation focus and resize recovery. Long titles/identifiers/tool names fit a 320 px viewport.                                                       |
| Accessibility     | No serious/critical axe WCAG 2 A/AA or 2.1 AA findings in tested desktop/mobile audit, comparison, method, library and import views across three engines.                                              |

The first browser journey uses real Worker/D1 storage. Other browser tests explicitly stub responses to isolate UI behavior or inject failures. API tests execute actual migrations, SQL and triggers through a SQLite adapter. The recovery rehearsal separately exercises actual local D1 and scheduled Worker bindings.

Hands-on review in the in-app browser checked evaluation, differing static/stateful revoked-approval decisions, expanded evidence, comparison, malformed input, cancellation/focus return, example download, mobile fixture navigation and visual wrapping. Automated journeys supply broader repeatable coverage. This is not an independent penetration test or comprehensive screen-reader study.

## Coverage and local performance

Instrumented schema, evaluator, storage client, import parser and Worker coverage: **98.96% lines, 98.58% statements, 96.36% branches and 100% functions**. React components, fixtures, tests and scripts are excluded from these percentages. UI correctness is checked through browser tests and review. Execution coverage does not prove security or correctness.

- A **65,536-byte, 200-event trace with 80 proposals** evaluated in a median **0.569 ms** across 15 uninstrumented measurements; the regression threshold is 100 ms. Instrumented median: 1.390 ms.
- Application JavaScript/CSS totaled **115,385 bytes gzip**, below 250 KiB.
- Local usability smoke checks completed in **580 ms Chromium, 595 ms Firefox and 583 ms WebKit**, including a 500 ms network-idle observation. These are not Core Web Vitals or mobile-network results.
- The Worker dry run packaged 783.75 KiB uncompressed / 124.07 KiB gzip and recognized D1, assets and the limiter. Packaging does not prove Free-plan entitlement or remote CPU headroom.

## Recovery rehearsal

`node scripts/recovery-rehearsal.mjs` creates isolated source/recovery databases under `.artifacts`, leaving preview and test databases untouched. SQL export/import preserves migration history, both indexes and both triggers. Insert/delete moves the restored counter **2 → 3 → 2**. Actual local scheduled cleanup removes only the expired row (**2 → 1**); a second invocation leaves the survivor unchanged. Source counts and content remain unchanged, local SQLite integrity checks pass, and the temporary server stops afterward.

Evidence: `.artifacts/recovery-2026-09-17T07-38-55-940Z/manifest.json`. The script records provider-specific details: local export uses isolated configurations because the command lacks `--persist-to`; scheduled test routing must precede SPA assets; integrity checks read only the isolated local SQLite file because D1 rejects the PRAGMA. Remote recovery is unverified.

## Recordings

`npm run record:walkthrough` captures continuous real browser interaction using synthetic examples. Desktop duration: approximately **2 minutes 11 seconds**. Mobile: approximately **34 seconds**. Chapter timings and completion/error records: `.artifacts/walkthrough/chapters.json`.

Desktop coverage includes all eight fixtures, evidence/log/raw inspection, comparisons, multiple actions/consumed grant allowance, unsupported tools, partial history, save/reload/open/export/delete, invalid JSON, digest rejection, file import, storage failure/recovery and method boundaries. Mobile covers navigation, evidence, comparison, import dismissal/focus and the library.

HTTP 503 responses are deliberately injected only in the failure demonstration. Save/reload/delete use the actual local backend. MP4 versions add a caption strip below the original viewport; original WebM files remain available. No audio, reconstructed UI or public-deployment footage. Both MP4 files passed complete decoding checks, visual frame inspection and Chromium playback/chapter seeking. One native video-control interaction crashed the in-app browser; use the downloaded MP4 in a normal media player if that viewer issue recurs. With FFmpeg installed, `FFMPEG_PATH=/absolute/path/to/ffmpeg node scripts/prepare-walkthrough.mjs` prepares MP4 files and the chapter player.

## Outstanding release gates

1. Connect Cloudflare; confirm Workers Free and native limiter availability without paid services.
2. Create remote D1, set its ID, apply the migration and deploy.
3. Test the actual HTTPS URL one browser project at a time, waiting for the write limiter between projects. Verify cookie flags, persistence/isolation, scheduled cleanup and provider CPU/usage behavior.
4. Provide GitHub write access for `rahul-singh-au9`, publish and inspect hosted CI.

No claim is made that every possible input was tested or no vulnerabilities remain. The [Engineering review](ENGINEERING_REVIEW.md), [Threat model](THREAT_MODEL.md) and [Operations](OPERATIONS.md) describe anonymous quota consumption, cookie recovery, uncertain non-idempotent saves and unverified trace provenance.
