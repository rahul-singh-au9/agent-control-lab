# Verification record

Date: 2026-09-17. Scope: local release candidate on macOS ARM64, Node 24.21.0, Chromium 153 through Playwright 1.63.0, Wrangler 4.133.0 with local D1 and native rate-limit bindings.

**Implemented and locally verified. Not deployed.** Cloudflare authentication is not available, the configuration still contains a placeholder remote database ID, and the GitHub publishing account is unresolved. No live URL, remote database, or hosted CI result is claimed.

## Executed checks

| Check | Result |
| --- | --- |
| Strict TypeScript | Passed |
| Engine and API tests | 37 passed across two files |
| Production build | Passed |
| Chromium browser tests | 6 passed |
| Dependency audit | 0 reported vulnerabilities at the time of checking |
| Local D1 migration | Applied successfully |
| Desktop/mobile visual review | Inspected audit, comparison and import views; mobile at 390 px |

Engine tests cover eight authored examples; scope, expiry, revocation, usage, state changes and partial coverage; strict input limits; duplicate and broken references; exclusion of future information; label/decision independence; no network execution; and empty-denominator behavior.

API tests execute the actual migration, SQL statements and triggers in SQLite. They verify cookie flags, owner isolation, cross-origin defenses, expiry, malformed UTF-8, bounded streamed bodies, generic service failures, and capacity races. At 1,999 actual rows, eight concurrent saves from different owners admit exactly one additional row. Browser tests independently exercise the real local Worker/D1 bindings.

Browser journeys verify evaluate → compare → export → import → save → reload → open → delete. A second isolated browser cannot read or delete a known report ID. They also cover unavailable storage, invalid JSON, a tampered export digest, keyboard operation and restored dialog focus.

Accessibility checks use axe WCAG 2 A/AA and 2.1 AA rules. No serious or critical violations were found in the tested desktop/mobile audit views, comparison, method, library, and import dialog. No horizontal page overflow was found at 390 px. Automated checks and limited keyboard review are not a comprehensive accessibility certification or screen-reader study.

## Measured local performance

- A valid trace with exactly **65,536 UTF-8 bytes, 200 events and 80 labelled proposals** evaluated in a median **0.590 ms** across 15 measurements after three warmups in the final unit run. The regression threshold is 100 ms. Timing includes validation and both policies.
- Application JavaScript and CSS totaled **114,249 bytes gzip**, below the 250 KiB target.
- The local browser usability check completed in **589 ms**, including a 500 ms network-idle observation, below its conservative 10-second smoke-test threshold. It is not a mobile-network or Core Web Vitals measurement.

These measurements describe this machine and input. They do not establish Cloudflare CPU usage, global latency, sustained concurrency, or availability.

## Corrections during verification

The first accessibility run found low-contrast text and undersized labels; both were corrected before the passing run. A stronger keyboard assertion found missing focus restoration after import; dialog cleanup now restores focus. Repeated tests against a shared preview hit the intended limiter, so browser tests now use an isolated backend/database on port 8788 rather than the interactive preview's allowance.

## Outstanding release steps

1. Authorize Cloudflare and verify Workers Free. Confirm native rate-limit binding availability without enabling a paid add-on.
2. Create remote D1, set its ID, apply the migration, and deploy.
3. Run browser tests against the actual HTTPS URL; verify health, storage, cookie flags and isolation. Verify scheduled cleanup and actual provider limits/CPU behavior.
4. Confirm the GitHub destination, publish, and verify hosted CI.

This release supports normalized `publish_artifact` traces and two fixed policies. Live interception, model inference, arbitrary policy scripting, external log adapters, verified source provenance, team accounts, and research results from real agent runs are outside its scope.
