# Curlsmith Threat Model

## Scope

This document covers the initial passive Firefox extension implementation. Curlsmith observes browser requests only for user-approved host permissions, stores bounded request and response metadata locally, renders redacted inspection views, and generates cURL commands.

Excluded capabilities are treated as out of scope for this implementation: crawling, automatic replay, remote parsing, telemetry, cloud sync, executable parser plugins, WebSocket frame capture, and credential harvesting workflows.

## Trust Boundaries

1. Website pages and page scripts are untrusted.
2. Browser WebExtension APIs are trusted only as privilege boundaries, not as input validators.
3. Extension UI pages are privileged but receive user-controlled captured data.
4. Background scripts are the highest-privilege extension domain.
5. IndexedDB and `storage.local` are local persistence for sensitive data, not a disclosure-safe log.
6. Clipboard and downloads are exfiltration boundaries because users may paste or export secrets.

## Sensitive Assets

1. Request headers, especially `Authorization`, cookies, CSRF/XSRF tokens, API keys, and session identifiers.
2. Request bodies, query parameters, and form fields.
3. Response bodies that may contain private messages, account data, financial data, or proprietary API data.
4. Parsed entities and search previews derived from captured responses.
5. Capture settings and host permission state.
6. Local audit metadata about full-fidelity copy actions.

## Privilege Levels

1. Web pages: no access to extension internals.
2. Extension UI: can request host permissions after user action, inspect local captures, and copy commands.
3. Background script: registers `webRequest` listeners, filters response streams, stores captures, and answers validated messages.
4. Firefox: grants host permissions and enforces WebExtension API boundaries.

## Escalation Paths

1. A malicious page attempts to send crafted messages to privileged extension handlers.
2. Captured HTML or JSON contains script-like content that could execute if rendered unsafely.
3. A parser rule or malformed payload attempts to trigger prototype pollution, deep recursion, memory exhaustion, or dynamic execution.
4. A captured token leaks through cURL generation, UI search text, logs, exports, or clipboard copy.
5. Response filtering stalls page loads if the stream is not always forwarded and closed.
6. Large or streaming responses exhaust memory or quota.
7. Optional `<all_urls>` host access becomes broader than the user intended.

## Initial Mitigations

1. No remote code, no telemetry, no remote parsing, and no runtime dependency downloads.
2. Runtime host permission is required before traffic is captured.
3. Background messages are validated with exact action schemas and unknown fields are rejected.
4. Captured content is rendered via `textContent`, never `innerHTML`.
5. Secrets are redacted by default in generated cURL and previews.
6. Full-fidelity cURL generation requires an explicit reveal flag from the UI.
7. Request and response body capture is byte-capped.
8. Stream filters write original chunks before copying samples.
9. Parser traversal has depth and candidate-count limits.
10. Storage retention runs after writes and can purge all captures.

## Open Hardening Items

1. Add encrypted local vault support before recommending long retention windows.
2. Add browser automation tests with a local server before release.
3. Add static analysis and dependency scanning if a build toolchain is introduced.
4. Add AMO policy review checks before packaging.
