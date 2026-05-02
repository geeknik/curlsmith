import {
  BODY_KIND,
  BROWSER_GENERATED_HEADER_NAMES,
  DEFAULT_REPLAY_HEADER_NAMES,
  OMIT_REPLAY_HEADERS
} from "./constants.js";
import {
  isSensitiveHeaderName,
  isSensitiveKey,
  isTokenLike,
  redactHeader,
  redactJsonValue,
  redactUrl
} from "./redactor.js";
import { shSingleQuote } from "./shell-escape.js";

function lowerHeaderName(header) {
  return String(header.name || "").toLowerCase();
}

function shouldIncludeHeader(header) {
  const name = lowerHeaderName(header);
  if (!name || OMIT_REPLAY_HEADERS.has(name)) {
    return false;
  }

  if (name.startsWith("sec-")) {
    return false;
  }

  if (DEFAULT_REPLAY_HEADER_NAMES.has(name)) {
    return true;
  }

  if (name.startsWith("x-")) {
    return true;
  }

  return !BROWSER_GENERATED_HEADER_NAMES.has(name);
}

function bodyFlagForKind(kind) {
  if (kind === BODY_KIND.FORM || kind === BODY_KIND.JSON || kind === BODY_KIND.TEXT || kind === BODY_KIND.UNKNOWN) {
    return "--data-raw";
  }
  return "--data-binary";
}

function isPrettyProfile(profile) {
  return profile.startsWith("pretty") || profile === "heredoc-json";
}

function buildHeredoc(bodyText) {
  return `--data-binary @- <<'EOF'\n${bodyText}\nEOF`;
}

function redactTokenLikeText(text) {
  return text
    .split(/(\s+)/)
    .map((part) => isTokenLike(part) ? "<REDACTED>" : part)
    .join("");
}

function bodyTextForCurl(text, kind, revealSecrets) {
  if (revealSecrets) {
    return text;
  }

  if (kind === BODY_KIND.JSON || text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    try {
      return JSON.stringify(redactJsonValue(JSON.parse(text)));
    } catch {
      return redactTokenLikeText(text);
    }
  }

  if (kind === BODY_KIND.FORM) {
    const params = new URLSearchParams(text);
    const redacted = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      redacted.append(key, isSensitiveKey(key, value) ? "<REDACTED>" : value);
    }
    return redacted.toString();
  }

  return redactTokenLikeText(text);
}

function joinPrettyLines(lines) {
  return lines.map((line, index) => {
    return index === lines.length - 1 ? line : `${line} \\`;
  }).join("\n");
}

export function generateCurl(capture, options = {}) {
  const profile = options.profile || "pretty-redacted";
  const revealSecrets = options.revealSecrets === true;
  const includeCookies = options.includeCookies === true;
  const requestBodyText = typeof options.requestBodyText === "string" ? options.requestBodyText : "";
  const warnings = Array.isArray(capture.replay?.warnings)
    ? capture.replay.warnings.slice()
    : [];
  const tokens = ["curl"];
  const lines = [];
  const method = String(capture.request?.method || "GET").toUpperCase();
  const url = redactUrl(capture.request.url, revealSecrets);
  const quotedUrl = shSingleQuote(url);

  tokens.push(quotedUrl);
  lines.push(`curl ${quotedUrl}`);

  function addArg(...args) {
    tokens.push(...args);
    lines.push(args.join(" "));
  }

  if (method !== "GET" && !(method === "POST" && requestBodyText)) {
    addArg("-X", method);
  }

  for (const header of capture.request.headers || []) {
    const name = lowerHeaderName(header);
    if (!shouldIncludeHeader(header)) {
      if (OMIT_REPLAY_HEADERS.has(name) || BROWSER_GENERATED_HEADER_NAMES.has(name)) {
        warnings.push("browser_generated_headers_omitted");
      }
      continue;
    }

    if (name === "cookie" && revealSecrets && !includeCookies) {
      const redacted = redactHeader(header, false);
      addArg("-H", shSingleQuote(`${redacted.name}: ${redacted.value}`));
      warnings.push("cookies_redacted");
      continue;
    }

    const redacted = redactHeader(header, revealSecrets);
    if (isSensitiveHeaderName(header.name) && !revealSecrets) {
      if (name === "cookie") {
        warnings.push("cookies_redacted");
      } else {
        warnings.push("authorization_redacted");
      }
    }
    addArg("-H", shSingleQuote(`${redacted.name}: ${redacted.value}`));
  }

  const requestBody = capture.request.body;
  if (requestBody?.truncated) {
    warnings.push("body_truncated");
  } else if (requestBody?.kind === BODY_KIND.BINARY) {
    warnings.push("binary_body_requires_export");
  } else if (requestBody?.kind === BODY_KIND.MULTIPART) {
    warnings.push("multipart_approximation");
  } else if (requestBodyText && requestBody?.kind !== BODY_KIND.NONE) {
    const safeRequestBodyText = bodyTextForCurl(requestBodyText, requestBody.kind, revealSecrets);
    if (profile === "heredoc-json" || (requestBody.kind === BODY_KIND.JSON && safeRequestBodyText.length > 4096)) {
      const heredoc = buildHeredoc(safeRequestBodyText);
      tokens.push(heredoc);
      lines.push(heredoc);
    } else {
      addArg(bodyFlagForKind(requestBody.kind), shSingleQuote(safeRequestBodyText));
    }
  }

  const uniqueWarnings = Array.from(new Set(warnings));
  const command = isPrettyProfile(profile) ? joinPrettyLines(lines) : tokens.join(" ");

  return {
    command,
    warnings: uniqueWarnings
  };
}
