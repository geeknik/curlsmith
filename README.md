# Curlsmith

Firefox-first, local-first API capture and styled cURL generation.

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

`npm run check` runs unit tests, JavaScript syntax checks, and `web-ext lint`.
`npm run package:extension` writes an unsigned extension ZIP to `web-ext-artifacts/`.
