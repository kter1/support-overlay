# Security and privacy review

Reviewed October 25, 2026. This is a source, configuration, dependency, and local
runtime review of the prototype; it is not a penetration test or a certification.

## Scope and disclosure checks

- Inspected authentication, tenant boundaries, webhook signatures, fixture
  injection, request/error logging, stored conversation data, packaging, and
  browser credential handling.
- Scanned 142 tracked text files and 353 reachable historical text blobs for
  common provider-key formats, private keys, credential URLs, email addresses,
  and exact matches to current generated local credentials. No live provider
  key or current generated credential match was detected in published source.
  Historical examples contain demo credentials/placeholders; those are public
  values and must never be used for real services.
- Checked all 35 one-second samples from the demo video with text recognition,
  and visually inspected its four scenes. No email address or provider-key
  pattern was detected. Displayed transactions and customer messages are fixture
  data. Text recognition is imperfect; this is not proof that every possible
  form of personal information is absent.
- Existing Git author/committer metadata includes contact addresses. An upstream
  dependency's deprecation notice also contains its maintainer's public contact.
  These are not customer records. Existing history was not rewritten.
- Local generated credentials remain in the ignored, owner-readable `.env`.
  An older local startup log containing a generated credential was sanitized.

## Remediated findings

| Finding | Change |
| --- | --- |
| Fixture endpoint could bypass signature verification outside an explicit simulator setup | `/webhooks/fixture` now returns 404 in production, when any provider simulator is disabled, or when simulator flags are absent. Webhook authentication still applies. |
| Invalid signatures were acknowledged and their raw payloads stored, allowing unverified content and event-ID poisoning | Provider webhook routes reject invalid signatures with 401 before storing payloads or event identifiers. A rejected event cannot block a later correctly signed event with the same ID. |
| Startup and malformed connection errors could expose credentials | Startup no longer prints the operator token; database URL parsing errors no longer echo the supplied connection string. |
| Request and exception logs could disclose query values, provider bodies, or database details | Request logs use route templates; errors retain safe categories/codes rather than messages, stack traces, or database detail. Worker/pool logging uses the same error minimization. Correlation headers are bounded and restricted to identifier characters. |
| Installed app builds could inherit the standalone browser credential | Packaging explicitly clears the demo browser token and API URL before building. Installed requests continue through Zendesk's secure settings. |
| Direct callers could spoof forwarded connection metadata | Proxy-header trust is disabled by default. A deployment needing trusted proxies requires an explicit, narrowly configured policy. |
| Sensitive API responses could be cached | API responses now specify `Cache-Control: no-store`. |
| Vulnerable compatible transitive versions | Updated `proxy-addr` and all locked `fast-uri` versions without forcing major dependency upgrades. |

## Dependency audit: unresolved

The registry audit initially reported 56 affected packages, including 11 in the
production dependency tree. After compatible updates it reports **49 affected
packages overall** and **4 in production**. Counts include inherited dependency
findings; they are not a count of independently exploitable vulnerabilities.

| Tree | Critical | High | Moderate | Low |
| --- | ---: | ---: | ---: | ---: |
| All dependencies | 4 | 31 | 11 | 3 |
| Production dependencies | 0 | 3 | 1 | 0 |

Production findings remain in `fastify`, `find-my-way`, `zod`, and `uuid`.
Development findings include critical advisories in `vitest`/`tinypool` and
`concurrently`/`shell-quote`. Not every advisory's affected feature is used here,
but the dependency tree is **not cleared for production**. Upgrade the framework,
matching plugins, validation library, and development tooling in a dedicated
compatibility migration; do not run forced audit upgrades without regression
coverage. Keep development/test servers private.

## Remaining privacy and deployment work

- Real ticket bodies, excerpts/annotations, raw webhook/evidence payloads, audit
  payloads, and investigation notes can contain personal information. The schema
  includes some redaction fields, but there is no verified end-to-end retention
  scheduler or erasure workflow covering every copy, archive, and backup.
- Error messages persisted in execution records can include provider details.
  Those records need a defined minimization and retention policy even though
  routine console/request logs have been hardened.
- Integration signing secrets are stored in the database; secret encryption,
  rotation, access controls, and backup handling need deployment-level review.
  Live provider adapters use process-level credentials, so multi-tenant provider
  credential isolation requires additional work before a shared deployment.
- The standalone browser token is intentionally visible to the local demo
  browser. Do not host that build with real credentials. Installed app packages
  use secure server-side proxy settings instead.
- Infrastructure TLS, disk encryption, database privileges, external account
  permissions, backups, and live provider behavior were not established by this
  local review.

## Validation

Regression checks cover tenant isolation and revoked credentials, request
validation, webhook signatures/replays, disabled fixture bypass, invalid-event
poisoning, log privacy, malformed connection errors, and worker concurrency.
Packaging is additionally checked with a synthetic browser-token canary to
confirm it does not enter the distributable. The full local suite passed 249
tests, including six real-Postgres concurrency checks and the separately pending
sandbox-runner tests. Type checks, lint, packaging, the bundle credential canary
check, and all seven runtime smoke checks passed. The live API also returned
`Cache-Control: no-store`. See `TESTS.md` for execution commands.
