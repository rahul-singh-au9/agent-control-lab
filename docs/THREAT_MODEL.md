# Threat model

## Purpose and boundaries

Agent Control Lab audits recorded `publish_artifact` proposals against two deterministic authorization policies. It reconstructs grants, revocations, resource versions, and previous dispatches from the recorded event prefix. It does not execute actions or simulate their effects. It is a policy-testing application, not a security certification, a general prompt-injection detector, or a sandbox for executing arbitrary programs.

An imported trace is untrusted input. Its author, model name, timestamps, approvals, expected outcomes, and reported tool results can be fabricated. A format-valid import establishes structure, not provenance. Deterministic fixtures are labeled as fixtures; captured traces are user-provided records, not independently authenticated evidence of model behavior.

An audit can show which recorded proposals a policy would allow, block, or refer for review because evidence is incomplete. Unsupported tools receive no safety conclusion. It cannot predict how an agent would react after intervention. A grant in a trace is an input to the experiment, not proof that a real person authorized a real operation. Both policies see the same recorded history; their decisions never change later events.

Decisions apply at proposal time. An operational publication service would need to recheck authorization and content atomically at dispatch. The audit does not enforce that boundary or establish that a recorded dispatch was authorized when it occurred.

## Data flow

1. The browser loads application assets and bundled synthetic examples.
2. A visitor imports JSON or selects an example. Schema validation and deterministic evaluation run locally in browser memory. The application does not use localStorage as a report database.
3. Saving a report sends its validated trace to the same-origin API. Validation is repeated on the server; client-side checks are not a trust boundary.
4. The API derives an owner identifier from an anonymous cookie and stores the report in D1. Queries require both report identity and owner scope.
5. Export creates a local JSON file. Import does not execute embedded text, fetch supplied URLs, or invoke the tools named in that file.

There are no outbound model-provider calls or credentials for the external tools represented by traces. If these capabilities are added, the threat model and data disclosures must be revised before release.

## Assets and adversaries

The protected assets are saved traces, the anonymous session credential, isolation between visitors, evaluator correctness, database capacity, and availability within the free plan. Threats include malicious imports, crafted HTTP requests, accidental uploads of secrets, hostile websites attempting cross-origin actions, stolen browser credentials, and automated storage or request abuse.

The application operator and hosting provider are trusted to administer deployment and storage. Reports are not hidden from either. The design does not protect against a compromised user device, malicious browser extensions, compromise of the build pipeline, or a malicious operator.

## Controls and residual risks

| Threat | Required control | Remaining limitation |
| --- | --- | --- |
| Report access by another visitor | A cryptographically random 32-byte cookie; server-derived owner scope on list, read, and delete; generic not-found responses for foreign IDs | Cookie theft grants the corresponding access. A report ID alone must never be sufficient. |
| Session exposure | Production `HttpOnly`, `Secure`, and `SameSite=Strict`; no cookie in URLs, logs, exports, or frontend storage | HttpOnly prevents direct script reads, not actions by script already executing in the application's origin. |
| Cross-site mutation | Exact-origin checks and JSON content-type checks for mutations; same-origin frontend/API; no permissive credentialed CORS | These checks do not authenticate non-browser clients or stop abuse by an attacker using their own session. |
| Stored or reflected script injection | Render trace strings as text; avoid raw HTML, executable markdown, dynamic evaluation, and navigation to untrusted trace URLs; restrictive production CSP | A compromised dependency or deployment can undermine this protection. |
| SQL injection or client-controlled ownership | Bound SQL parameters; derive owner identity only from the validated cookie; allowlist accepted trace fields | Query scoping must be reviewed on every new endpoint. |
| Resource exhaustion | Enforce UTF-8 byte limits while reading the request; bound action count and string sizes; reject invalid data before database work; atomically enforce per-session/global report caps | Anonymous sessions can be multiplied. Distributed request abuse can exhaust free quotas even with storage caps. |
| Rate-limit bypass | Protect mutations before costly work; fail closed when required protection is unavailable; keep exact storage limits in D1 | Native edge counters are approximate and regional. Shared IPs create false positives; IP rotation creates bypass opportunities. |
| Sensitive trace disclosure | Explicit save action, local evaluation option, no body logging, and clear instruction to sanitize before upload | Validation does not discover all credentials, proprietary information, or personal data. |
| Retention mismatch | Filter expired rows at read time and run daily deletion; preserve counters during cleanup | Physical deletion depends on cleanup succeeding. Provider recovery history can retain prior database states. |
| Misleading evaluation | Show provenance category, rule decisions, and denominators; distinguish invalid input, unknown policy, and actual pass/fail | A narrow suite cannot establish general agent safety, and self-reported expectations are not independent ground truth. |

These are release requirements. Implementation and tests must demonstrate them; their presence in this document is not evidence that a deployed service has been verified.

## Session and data lifecycle

The session is a bearer capability, not a verified user account. A 32-byte random value makes guessing impractical when generated correctly, but it provides no identity recovery. Losing the cookie loses access. Export/import recovers content without transferring the old session's permissions. Sharing an export intentionally shares its contents.

Saved reports expire after 30 days, subject to the cleanup behavior described in [Operations](OPERATIONS.md). Browser-local copies and downloaded exports have separate lifetimes controlled by the visitor. Deleting a server report cannot delete copies a visitor has exported.

## Meaningful release tests

- Create reports in two isolated cookie jars; list, read, and delete must never cross owners, including a known valid foreign report ID.
- Exercise malformed, missing, ambiguous, and oversized session credentials without accepting a client-supplied owner field.
- Exercise cross-origin and absent-origin writes, incompatible content types, unsupported methods, malformed JSON, and arbitrary report path segments.
- Send a multibyte payload over the byte cap with no trustworthy `Content-Length`; verify rejection before insertion. Test a bounded but deeply nested input.
- Race simultaneous inserts at both capacity boundaries and confirm the database never exceeds the cap. Delete and expire records and verify counters remain correct.
- Import HTML/script strings, SQL-like strings, URLs, and prototype-related keys; confirm they remain inert data and cannot modify evaluator policy or object prototypes.
- Verify expired reports are inaccessible before cleanup; test cleanup after a failed invocation and at the exact expiration boundary.
- Force storage errors and rate-limit failures; verify no false success state, no uncontrolled retry loop, and continued local export.
- Test policy precedence, approval requirements, unsupported tools/resources, malformed resource paths, duplicate action IDs, and consistent decisions across export/import.

Use local services and synthetic traces for adversarial tests. The public deployment is not a target for quota exhaustion or penetration testing without a separately defined scope.
