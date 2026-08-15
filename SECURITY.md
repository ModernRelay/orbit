# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/ModernRelay/orbit/security/advisories/new)
— do not open a public issue for security-sensitive reports.

You can expect an acknowledgement within a few days. Please include a
reproduction (a snapshot + the API calls involved is usually enough) and the
package versions affected.

## Scope notes

- orbit treats **node/edge attrs as untrusted data**: rendering paths use text
  nodes (never `innerHTML`), ids are compared and never interpreted, and
  telemetry (`getPerfSnapshot`, `perfSample`) never carries raw attrs or ids.
- The worker lane exchanges **data only** — serializable descriptors are never
  evaluated as code, and unknown transform ops are validation errors.
- Reports about dependencies are welcome too; the supported versions are the
  latest published minor of each `@modernrelay/orbit-*` package.
