# Supply Chain Risk Report — `Gargantua`

**Scanned:** `<repo>`  
**Manifests read:** `package.json`, `package-lock.json`  
**Scanned at:** 2026-10-14T14:33:52+00:00  
**Direct dependencies:** 5 (npm 5)

## Summary

- **No known advisory affects any of the 5 direct dependencies**, checked at the versions this project resolves.
- No known advisory affects any of the 65 registry-verified transitive packages at their locked versions.
- 4 of 5 dependencies carry at least one finding, 0 of which reach production.
- Weakest coverage: **Publisher concentration**, established for 3 of 5; the Coverage section lists every criterion.

## Production dependencies

Every direct dependency is declared as a development dependency, so none
of them ships in the built artifact.

## Findings

### Build-time only

Declared as development dependencies. A compromise here reaches build and CI hosts rather than users of the shipped artifact.

| Dependency | Version | Weekly downloads | Findings |
|---|---|---|---|
| `@types/three` | 0.186.0 | 14,315,626/wk | single human publisher (types) of 1 listed |

## Upstream repository and CI hygiene — OpenSSF Scorecard

These criteria describe each dependency's own repository, not the audited
project. Remediation, where any exists, is upstream.

### Build-time only

Declared as development dependencies. A compromise here reaches build and CI hosts rather than users of the shipped artifact.

| Dependency | Version | Weekly downloads | Findings |
|---|---|---|---|
| `playwright-core` | 1.63.0 | 125,588,893/wk | Binary-Artifacts scores 6/10 (below 10) |
| `three` | 0.186.1 | 21,426,650/wk | Binary-Artifacts scores 7/10 (below 10) |
| `vite` | 8.3.1 | 195,261,248/wk | Binary-Artifacts scores 1/10 (below 10) |

## Transitive advisories

No known advisory affects any of the 65 registry-verified packages beyond the direct set (resolved by `package-lock.json`), at the locked versions. Only advisories were checked at this depth; every other criterion in this report describes direct dependencies only.

## Informational

Measured, not flagged.

- **CI token permissions**: median 7/10 across 5 scored dependencies; 2 score below 6. Not flagged — this measures whether CI workflows declare least-privilege tokens, which tracks project maturity rather than the likelihood of malicious code being published.
- **Changes reviewed by a second person**: median 9/10 across 5 scored dependencies; 1 score below 6. Not flagged — this measures the share of recent commits reviewed by a second person, which is low for most small single-maintainer projects and largely restates publisher concentration.
- **Publish provenance**: 2 of 5 publish with build provenance.
  Without: `@types/three`, `three`, `typescript`
- **Security policy published**: 5 of 5 publish a security policy.
- **Download volume**: established for 5 of 5; median 125,588,893/week. Lowest: `@types/three` (14,315,626/wk), `three` (21,426,650/wk), `playwright-core` (125,588,893/wk).

## Coverage

What was and was not measured, per criterion.

| Criterion | Tier | Assessed | Flagged | Not assessable |
|---|---|---|---|---|
| Known advisories | A | 5/5 | 0 | 0 |
| Deprecated or yanked | A | 5/5 | 0 | 0 |
| Repository archived | A | 5/5 | 0 | 0 |
| Maintenance activity | A | 5/5 | 0 | 0 |
| Publisher concentration | B | 3/5 | 1 | 2 |
| Install-time script execution | B | 5/5 | 0 | 0 |
| Dangerous CI workflow | scorecard | 5/5 | 0 | 0 |
| CI token permissions | scorecard | 5/5 | 0 | 0 |
| Checked-in binaries | scorecard | 5/5 | 3 | 0 |
| Changes reviewed by a second person | scorecard | 5/5 | 0 | 0 |
| Publish provenance | info | 5/5 | 0 | 0 |
| Security policy published | info | 5/5 | 0 | 0 |
| Download volume | info | 5/5 | 0 | 0 |

## Not assessable

**Publisher concentration**

- 2 dependencies — publishes from CI with provenance, so the effective publisher set is whoever can merge to the release branch — not externally observable: `playwright-core`, `vite`

## Method and caveats

- cache directory ownership was not verified: os.getuid is POSIX-only, so a cache at %USERPROFILE%\AppData\Local\Temp\supply-chain-risk-auditor-cache owned by another user would not be detected on this platform. Keep the cache under your own user profile, or pass --cache with a private path.
- gh is not authenticated. GitHub allows 60 requests/hour unauthenticated against 5000 authenticated, so repository signals may be unassessable.
- Optional tooling detected: npm. Not installed, so not used: bundler-audit, cargo-audit, osv-scanner, pip-audit.
- Every criterion except advisories applies to direct dependencies only. The 65 registry-verified packages resolved by package-lock.json were checked for known advisories at their locked versions, and for nothing else.
- HTTP sources: 27 fetched, 5 served from cache (oldest 0.0h old), 0 refetched as stale, 0 unavailable offline, 0 errors.
