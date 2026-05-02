import {
  REDACTED_VALUE,
  SENSITIVE_HEADER_PATTERN,
  SENSITIVE_KEY_PATTERN,
  TOKEN_LIKE_VALUE_PATTERN
} from "./constants.js";

const MAX_REDACTION_DEPTH = 32;
const MAX_REDACTION_KEYS = 20000;

export function isTokenLike(value) {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  return TOKEN_LIKE_VALUE_PATTERN.test(trimmed);
}

export function isSensitiveHeaderName(name) {
  return SENSITIVE_HEADER_PATTERN.test(String(name || ""));
}

export function isSensitiveKey(name, value) {
  const key = String(name || "");
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return true;
  }

  return key.toLowerCase() === "key" && isTokenLike(value);
}

export function redactScalar(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return REDACTED_VALUE;
}

export function redactHeader(header, revealSecrets = false) {
  const redacted = isSensitiveHeaderName(header.name);
  return {
    ...header,
    redacted,
    value: redacted && !revealSecrets ? REDACTED_VALUE : String(header.value ?? "")
  };
}

export function redactQueryValue(name, value, revealSecrets = false) {
  if (revealSecrets || !isSensitiveKey(name, value)) {
    return String(value ?? "");
  }

  return REDACTED_VALUE;
}

export function redactUrl(rawUrl, revealSecrets = false) {
  const url = new URL(rawUrl);
  if (!url.search) {
    return url.toString();
  }

  const pairs = Array.from(url.searchParams.entries());
  url.search = "";
  for (const [name, value] of pairs) {
    url.searchParams.append(name, redactQueryValue(name, value, revealSecrets));
  }
  return url.toString();
}

export function redactJsonValue(value, options = {}) {
  const revealSecrets = options.revealSecrets === true;
  const seen = new WeakSet();
  let visitedKeys = 0;

  function visit(current, keyName, depth) {
    if (depth > MAX_REDACTION_DEPTH) {
      return "[MaxDepth]";
    }

    if (isSensitiveKey(keyName, current) && !revealSecrets) {
      return redactScalar(current);
    }

    if (current === null || typeof current !== "object") {
      return current;
    }

    if (seen.has(current)) {
      return "[Circular]";
    }
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map((item) => visit(item, "", depth + 1));
    }

    const output = {};
    for (const [key, child] of Object.entries(current)) {
      visitedKeys += 1;
      if (visitedKeys > MAX_REDACTION_KEYS) {
        output.__truncated = true;
        break;
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      output[key] = visit(child, key, depth + 1);
    }
    return output;
  }

  return visit(value, "", 0);
}
