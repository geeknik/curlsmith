# Security Policy

Curlsmith captures browser request and response metadata for user-approved sites. Captures may contain credentials, cookies, tokens, private messages, account identifiers, or proprietary API data. Treat all capture data and exported entities as sensitive.

## Supported Versions

The project is pre-release. Security fixes target the current `main` branch until versioned releases begin.

## Reporting a Vulnerability

Please report vulnerabilities privately through GitHub Security Advisories for this repository. Do not open a public issue that includes exploit details, captured credentials, private traffic, or sensitive payloads.

If GitHub Security Advisories are unavailable, contact the maintainer through the GitHub profile listed on the repository and request a private disclosure channel.

## Project Security Expectations

- No telemetry, analytics, remote parsing, cloud sync, or hidden outbound extension requests are permitted without a new design review.
- No remote code execution, `eval`, dynamic function constructors, or captured-content `innerHTML` rendering.
- Runtime extension code must remain dependency-free unless a dependency is explicitly justified and reviewed.
- Dev-only dependencies must be pinned and must not be packaged into the extension artifact.
- Redacted export/copy paths must remain the default.

## Local Data

Captured data is stored in the browser profile using extension-local storage and IndexedDB. Local browser profile access can expose captures. Use short retention windows, purge captures after testing, and avoid capturing accounts or sites you are not authorized to inspect.
