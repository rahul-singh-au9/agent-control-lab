# Engineering and security review

Reviewed 2026-09-17. This is a bounded offline trace-auditing product with optional private storage. Review and test evidence support the controls below; they do not establish the absence of vulnerabilities or universal production readiness.

## Code quality controls

- Strict TypeScript, type-aware ESLint rules, React hook/dependency rules, and consistent formatting are executable checks. No lint warnings are permitted by the check command.
- The schema and pure evaluator are shared, with explicit limits and deterministic behavior. Storage, imports and UI orchestration have separate boundaries. Expected labels do not enter policy evaluation.
- Successful API responses are validated before entering UI state. Stored trace bodies are validated again on reads. Errors remain actionable to the user without exposing stored content or server exception details.
- Request generations prevent obsolete work from replacing newer UI actions. Requests and cross-tab session-lock acquisition have finite deadlines. Uncertain saves are not automatically retried.
- Production code does not use dynamic execution, arbitrary policy scripts, external URL fetching, raw HTML rendering or string-interpolated SQL. Imported content is rendered as text.
- Pinned dependencies, a lockfile, read-only CI permissions and pinned action revisions make changes reviewable. Dependency update configuration proposes updates; it does not merge them automatically. Hosted CI and update jobs have not run yet.
- Typed linting follows the [typescript-eslint type-information configuration](https://typescript-eslint.io/getting-started/typed-linting/); React hook checks follow the [React rule documentation](https://react.dev/reference/eslint-plugin-react-hooks). TypeScript 6.0.3 satisfies the parser's declared supported range; unsupported peer dependencies are not forced.

## Security boundaries reviewed

| Boundary             | Implementation and verification                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymous credential | 32 random bytes, HttpOnly, SameSite Strict, Secure on HTTPS, host-prefixed production cookie; only a digest is stored as owner identity. Raw cookies are not logged or returned in JSON. |
| Record ownership     | Every record read/delete is owner-scoped. Cross-browser isolation is exercised against actual local Worker/D1 bindings in three browser engines.                                         |
| Mutation origin      | Exact same-origin requests and fetch metadata checks; JSON content type and bounded request bodies. Cross-origin mutations and malformed cookies are rejected.                           |
| Imported data        | Strict fields, references, monotonic sequence/time, UTF-8 byte/event caps, fatal file decoding, bounded JSON nesting at the API, and digest checks when supplied.                        |
| Content rendering    | React text escaping; no trace URL fetching; CSP, frame denial, nosniff, same-origin resource policy and no-store API responses. Hostile title text is tested in the browser.             |
| Storage capacity     | Atomic owner/global admission, trigger-maintained counters, immediate expiry filtering and scheduled cleanup. Concurrency and failed cleanup recovery are tested.                        |
| Abuse protection     | Native write limiting fails closed when unavailable. It is approximate per location; exact storage caps are separate database invariants.                                                |
| Failure behavior     | Malformed successful responses, service errors, rate limits, timeouts and cancellation do not become saved success. Local evaluation and export stay available.                          |
| Recovery             | Isolated SQL export/restore preserves indexes, triggers and migration history. The actual local scheduled handler removes expired rows and is repeatable.                                |

## Corrections from this review

1. Rejected unsupported submillisecond timestamps that previously lost precision during expiry and ordering checks.
2. Guarded late imports, file reads, saved-report opens and library refreshes against newer user actions.
3. Serialized first-time session creation across tabs with Web Locks and bounded acquisition; same-page coalescing remains the fallback where unavailable.
4. Rejected malformed storage responses and corrupt stored traces instead of trusting a successful HTTP status.
5. Rejected malformed UTF-8 files and inconsistent bundle metadata.
6. Corrected oversized input status codes, bounded session payloads, route/method handling and deep-input failure behavior.
7. Fixed mobile long-text overflow, focus trapping, focus restoration and resize recovery.
8. Corrected cleanup logging: D1 mutation counts include trigger updates, so logs now say database changes rather than overstating deleted report counts.

## Performance and remaining limits

The engine and UI operate on at most 200 events and 64 KiB traces. Some evidence assembly and UI lookup work is quadratic in that bounded size; local stress tests support keeping the simple implementation. Measurements and code coverage are in the verification record. They are not evidence of remote CPU headroom or high-concurrency service behavior.

The cookie is a bearer credential, not an authenticated human identity. Loss of the cookie loses access; exports recover content only. Web Locks prevent ordinary same-origin tab races in supported browsers, not credential theft. Anonymous visitors can consume daily free quotas despite write throttling; there is no availability guarantee or paid burst capacity.

Save requests are not idempotent. A response lost after the database commits can leave an uncertain result; refresh the library before retrying to avoid an extra copy. This operation has no external tool effects and remains subject to the 20-report cap.

Trace provenance, labels and declared completeness are assertions. A digest detects changes to the normalized trace, not authenticity. Proposal recommendations neither reserve a grant use nor enforce dispatch-time authorization. This is not a runtime safety gateway or proof of AGI safety.

Remote HTTPS behavior, native binding entitlement, D1/Worker CPU and request limits, and deployed scheduled cleanup remain release gates. Hosted Linux CI has passed; the [verification record](VERIFICATION.md) links the run and its tested revision. Automated accessibility checks complement the tested keyboard/visual review; they are not a screen-reader certification or a physical-device test matrix.
