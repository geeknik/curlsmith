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

function buildHeredoc(bodyText) {
  return `--data-binary @- <<'EOF'\n${bodyText}\nEOF`;
}

function psSingleQuote(input) {
  return "'" + String(input).replace(/'/g, "''") + "'";
}

function fishSingleQuote(input) {
  return "'" + String(input).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
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

function raw(value) {
  return { value: String(value), quote: false };
}

function quoted(value) {
  return { value: String(value), quote: true };
}

function literal(value) {
  return { literal: String(value) };
}

function commandConfig(profile) {
  if (profile === "powershell") {
    return {
      commandName: "curl.exe",
      continuation: "`",
      pretty: true,
      quote: psSingleQuote,
      heredocLargeJson: false
    };
  }

  if (profile === "fish") {
    return {
      commandName: "curl",
      continuation: "\\",
      pretty: true,
      quote: fishSingleQuote,
      heredocLargeJson: false
    };
  }

  return {
    commandName: "curl",
    continuation: "\\",
    pretty: !profile.startsWith("compact"),
    quote: shSingleQuote,
    heredocLargeJson: profile.startsWith("pretty")
  };
}

function renderCommand(lines, config) {
  const rendered = lines.map((line) => {
    if (line.length === 1 && typeof line[0].literal === "string") {
      return line[0].literal;
    }
    return line.map((part) => part.quote ? config.quote(part.value) : part.value).join(" ");
  });

  if (!config.pretty) {
    return rendered.join(" ");
  }

  return rendered.map((line, index) => {
    return index === rendered.length - 1 ? line : `${line} ${config.continuation}`;
  }).join("\n");
}

function payloadFilenameForKind(kind) {
  if (kind === BODY_KIND.JSON) {
    return "curlsmith-request-body.json";
  }
  if (kind === BODY_KIND.BINARY) {
    return "curlsmith-request-body.bin";
  }
  if (kind === BODY_KIND.MULTIPART) {
    return "curlsmith-request-body.multipart";
  }
  return "curlsmith-request-body.txt";
}

function willEmitRequestBody(profile, requestBody, requestBodyText) {
  if (!requestBody || requestBody.truncated || requestBody.kind === BODY_KIND.NONE) {
    return false;
  }
  if (profile === "binary-file") {
    return true;
  }
  if (requestBody.kind === BODY_KIND.BINARY || requestBody.kind === BODY_KIND.MULTIPART) {
    return false;
  }
  return Boolean(requestBodyText);
}

export function generateCurl(capture, options = {}) {
  const profile = options.profile || "pretty-redacted";
  const config = commandConfig(profile);
  const revealSecrets = options.revealSecrets === true;
  const includeCookies = options.includeCookies === true;
  const requestBodyText = typeof options.requestBodyText === "string" ? options.requestBodyText : "";
  const warnings = Array.isArray(capture.replay?.warnings)
    ? capture.replay.warnings.slice()
    : [];
  const lines = [];
  const method = String(capture.request?.method || "GET").toUpperCase();
  const url = redactUrl(capture.request.url, revealSecrets);
  const requestBody = capture.request.body;
  const bodyWillBeEmitted = willEmitRequestBody(profile, requestBody, requestBodyText);

  lines.push([raw(config.commandName), quoted(url)]);

  function addArg(...args) {
    lines.push(args);
  }

  if (method !== "GET" && !(method === "POST" && bodyWillBeEmitted)) {
    addArg(raw("-X"), raw(method));
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
      addArg(raw("-H"), quoted(`${redacted.name}: ${redacted.value}`));
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
    addArg(raw("-H"), quoted(`${redacted.name}: ${redacted.value}`));
  }

  if (requestBody?.truncated) {
    warnings.push("body_truncated");
  } else if (profile === "binary-file" && requestBody && requestBody.kind !== BODY_KIND.NONE) {
    addArg(raw("--data-binary"), quoted(`@${payloadFilenameForKind(requestBody.kind)}`));
    warnings.push("payload_file_required");
    if (requestBody.kind === BODY_KIND.BINARY) {
      warnings.push("binary_body_requires_export");
    } else if (requestBody.kind === BODY_KIND.MULTIPART) {
      warnings.push("multipart_approximation");
    }
  } else if (requestBody?.kind === BODY_KIND.BINARY) {
    warnings.push("binary_body_requires_export");
  } else if (requestBody?.kind === BODY_KIND.MULTIPART) {
    warnings.push("multipart_approximation");
  } else if (requestBodyText && requestBody?.kind !== BODY_KIND.NONE) {
    const safeRequestBodyText = bodyTextForCurl(requestBodyText, requestBody.kind, revealSecrets);
    if (profile === "heredoc-json" || (config.heredocLargeJson && requestBody.kind === BODY_KIND.JSON && safeRequestBodyText.length > 4096)) {
      lines.push([literal(buildHeredoc(safeRequestBodyText))]);
    } else {
      addArg(raw(bodyFlagForKind(requestBody.kind)), quoted(safeRequestBodyText));
    }
  }

  const uniqueWarnings = Array.from(new Set(warnings));
  const command = renderCommand(lines, config);

  return {
    command,
    warnings: uniqueWarnings
  };
}
