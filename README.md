# Curlsmith

[![CI](https://github.com/geeknik/curlsmith/actions/workflows/ci.yml/badge.svg)](https://github.com/geeknik/curlsmith/actions/workflows/ci.yml)
[![Firefox](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefox-browser&logoColor=white)](https://www.mozilla.org/firefox/)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-2f4f4f)
[![License](https://img.shields.io/github/license/geeknik/curlsmith)](LICENSE)

Firefox-first, local-first API capture and styled cURL generation.

Curlsmith is pre-release software for controlled local testing. It captures request and response metadata for sites you approve and stores that data locally in the browser profile. Captures may include credentials, cookies, tokens, private messages, account data, or proprietary API data.

Do not capture sites, accounts, or traffic you are not authorized to inspect.

## What Works Today

- Runtime host permission flow with capture scopes for off, current tab, current site, and approved sites.
- Passive request capture for method, URL, headers, request body samples, response status, response headers, response body samples, redirects, truncation state, binary markers, and hashes.
- Bounded local storage in IndexedDB with retention settings for max records, TTL, request cap, response cap, and total payload cap.
- Redaction by default for authorization headers, cookies, CSRF/XSRF tokens, API keys, query secrets, JSON body secrets, form secrets, and token-like text.
- cURL profiles for pretty, compact, full-fidelity reveal, here-doc JSON, body-file replay, PowerShell, and Fish.
- Basic entity extraction from JSON and NDJSON responses for users, posts, comments, messages, media, and unknown entities.
- Sidebar inspection, filtering, redacted JSON tree rendering, cURL copy, entity JSONL/CSV export, purge all, and purge current site.
- Options page controls for capture, parser, retention, storage caps, and approved origins.
- CI, Mozilla add-on linting, runtime dependency audit, unsigned ZIP packaging, and package exclusion checks.

## Security and Privacy Posture

- Local-only by design: no telemetry, analytics, remote parsing, cloud sync, or hidden outbound extension requests.
- Runtime extension code is dependency-free.
- Captured content is rendered as text, not HTML.
- Full-fidelity cURL copy requires explicit reveal and records local audit metadata without secret values.
- Packages exclude local planning, agent, test, and docs files.
- Captures remain sensitive even when stored locally; purge after testing and keep retention windows short.

## Local Firefox Check

1. Load `extension/` as a temporary add-on from `about:debugging#/runtime/this-firefox`.
2. Start the local fixture server:

   ```sh
   npm run dev:server
   ```

3. Open `http://127.0.0.1:8787/` in Firefox.
4. Open the Curlsmith popup and click **Allow site**.
5. Click **Run API Fixtures** on the fixture page.
6. Open the Curlsmith sidebar and inspect the captured requests.

Expected behavior:

- Requests to `/api/users`, `/api/posts`, `/graphql`, `/api/ndjson`, `/api/large`, `/api/binary`, and `/api/redirect` appear in the sidebar.
- Redacted cURL output does not expose `Authorization`, cookies, CSRF headers, query tokens, or token-like body fields.
- Full-fidelity cURL requires the **Reveal copy** path.
- Captured response previews are bounded, and the large response is marked truncated.
- PowerShell, Fish, here-doc JSON, and body-file cURL profiles are available from the cURL profile selector.
- Extracted entities can be exported as JSONL or CSV without raw captured objects.

The fixture server intentionally uses fake test tokens only. Use it for repeatable local checks before testing against real traffic.

## Project Checks

```sh
npm ci
npm run check
npm run package:extension
npm audit
```

`npm run check` runs unit tests, JavaScript syntax checks, Mozilla add-on linting, and a runtime dependency audit.
`npm run package:extension` writes an unsigned extension ZIP to `web-ext-artifacts/`.
`npm audit` verifies the full npm dependency surface.

`addons-linter` is pinned as a dev dependency so CI and local linting use the same add-on policy checks.

## Known Gaps Before Public Release

- AMO signing and listing review are not done.
- End-to-end browser automation for permission granting and capture assertions is not in CI.
- Extension packages are unsigned and intended only for local testing.
