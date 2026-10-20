# Supply Chain Risk Report — `pipeline`

**Scanned:** `<repo>\pipeline`  
**Manifests read:** `pyproject.toml`, `uv.lock`  
**Scanned at:** 2026-10-14T14:34:02+00:00  
**Direct dependencies:** 4 (PyPI 4)

## Summary

- **No known advisory affects any of the 4 direct dependencies**, checked at the versions this project resolves.
- No known advisory affects any of the 5 registry-verified transitive packages at their locked versions.
- 0 of 4 dependencies carry at least one finding, 0 of which reach production.
- Weakest coverage: **Install-time script execution**, established for 0 of 4; the Coverage section lists every criterion.

## Production dependencies

2 dependencies are declared as runtime dependencies and ship in the built artifact. Advisory status is given for every one, clean or not.

| Dependency | Version | Advisories | Other findings |
|---|---|---|---|
| `numpy` | 2.4.6 | none known | — |
| `opencv-python-headless` | 4.14.0.94 | none known | — |

## Findings

No dependency was flagged on these criteria.

## Upstream repository and CI hygiene — OpenSSF Scorecard

These criteria describe each dependency's own repository, not the audited
project. Remediation, where any exists, is upstream.

No dependency was flagged on these criteria.

## Transitive advisories

No known advisory affects any of the 5 registry-verified packages beyond the direct set (resolved by `uv.lock`), at the locked versions. Only advisories were checked at this depth; every other criterion in this report describes direct dependencies only.

## Informational

Measured, not flagged.

- **CI token permissions**: median 9/10 across 3 scored dependencies; 1 score below 6. Not flagged — this measures whether CI workflows declare least-privilege tokens, which tracks project maturity rather than the likelihood of malicious code being published.
- **Changes reviewed by a second person**: median 10/10 across 3 scored dependencies; 1 score below 6. Not flagged — this measures the share of recent commits reviewed by a second person, which is low for most small single-maintainer projects and largely restates publisher concentration.
- **Publish provenance**: not determinable for any dependency in this project.
- **Security policy published**: 3 of 4 publish a security policy.
  Without: `opencv-python-headless`
- **Download volume**: not determinable for any dependency in this project.

## Coverage

What was and was not measured, per criterion.

| Criterion | Tier | Assessed | Flagged | Not assessable |
|---|---|---|---|---|
| Known advisories | A | 4/4 | 0 | 0 |
| Deprecated or yanked | A | 4/4 | 0 | 0 |
| Repository archived | A | 4/4 | 0 | 0 |
| Maintenance activity | A | 4/4 | 0 | 0 |
| Publisher concentration | B | 0/4 | 0 | 4 |
| Install-time script execution | B | 0/4 | 0 | 4 |
| Dangerous CI workflow | scorecard | 3/4 | 0 | 1 |
| CI token permissions | scorecard | 3/4 | 0 | 1 |
| Checked-in binaries | scorecard | 3/4 | 0 | 1 |
| Changes reviewed by a second person | scorecard | 3/4 | 0 | 1 |
| Publish provenance | info | 0/4 | 0 | 4 |
| Security policy published | info | 4/4 | 0 | 0 |
| Download volume | info | 0/4 | 0 | 4 |

## Not assessable

**Checked-in binaries**

- 1 dependency — OpenSSF Scorecard has no report for this repository: `ruff`

**Changes reviewed by a second person**

- 1 dependency — OpenSSF Scorecard has no report for this repository: `ruff`

**Dangerous CI workflow**

- 1 dependency — OpenSSF Scorecard has no report for this repository: `ruff`

**Download volume**

- 4 dependencies — PyPI's download counters are disabled and return -1: `numpy`, `opencv-python-headless`, `pytest`, `ruff`

**Install-time script execution**

- 4 dependencies — install-time execution depends on whether a wheel or an sdist is installed, which this collector does not determine: `numpy`, `opencv-python-headless`, `pytest`, `ruff`

**Publish provenance**

- 4 dependencies — PyPI publish attestations are not read by this collector: `numpy`, `opencv-python-headless`, `pytest`, `ruff`

**Publisher concentration**

- 4 dependencies — PyPI publishes no upload ACL, so who can publish this package is not observable: `numpy`, `opencv-python-headless`, `pytest`, `ruff`

**CI token permissions**

- 1 dependency — OpenSSF Scorecard has no report for this repository: `ruff`

## Method and caveats

- cache directory ownership was not verified: os.getuid is POSIX-only, so a cache at %USERPROFILE%\AppData\Local\Temp\supply-chain-risk-auditor-cache owned by another user would not be detected on this platform. Keep the cache under your own user profile, or pass --cache with a private path.
- gh is not authenticated. GitHub allows 60 requests/hour unauthenticated against 5000 authenticated, so repository signals may be unassessable.
- Optional tooling detected: npm. Not installed, so not used: bundler-audit, cargo-audit, osv-scanner, pip-audit.
- Every criterion except advisories applies to direct dependencies only. The 5 registry-verified packages resolved by uv.lock were checked for known advisories at their locked versions, and for nothing else.
- HTTP sources: 17 fetched, 4 served from cache (oldest 0.0h old), 0 refetched as stale, 0 unavailable offline, 0 errors.
