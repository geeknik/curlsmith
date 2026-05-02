# Curlsmith

Firefox-first, local-first API capture and styled cURL generation.

Curlsmith is pre-release software for controlled local testing. It captures request and response metadata for sites you approve and stores that data locally in the browser profile. Captures may include credentials, cookies, tokens, private messages, account data, or proprietary API data.

Do not capture sites, accounts, or traffic you are not authorized to inspect.

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

The fixture server intentionally uses fake test tokens only. Do not run capture against real accounts until browser integration tests and AMO hardening checks are in place.

## Project Checks

```sh
npm run check
npm run package:extension
```

`npm run check` runs unit tests, JavaScript syntax checks, Mozilla add-on linting, and a runtime dependency audit.
`npm run package:extension` writes an unsigned extension ZIP to `web-ext-artifacts/`.

Runtime extension code is dependency-free. `addons-linter` is pinned as a dev dependency so CI and local linting use the same add-on policy checks.

## Known Gaps Before Public Release

- Browser-level smoke tests are still manual.
- Some cURL profiles from the design, including PowerShell, Fish, and binary-file output, are not implemented.
- Extension packages are unsigned and intended only for local testing.
