import {
  BODY_KIND,
  JSON_CONTENT_TYPE_PATTERN,
  TEXT_CONTENT_TYPE_PATTERN
} from "./constants.js";

const DEFAULT_PREVIEW_CHARS = 4096;

export function normalizeHeaders(headers = []) {
  const map = new Map();
  for (const header of headers) {
    const name = String(header.name || "").toLowerCase();
    if (!name) {
      continue;
    }
    map.set(name, String(header.value ?? ""));
  }
  return map;
}

export function getHeader(headers, name) {
  return normalizeHeaders(headers).get(name.toLowerCase()) || "";
}

export function parseContentType(headers = []) {
  const contentType = getHeader(headers, "content-type");
  const charsetMatch = /;\s*charset=([^;]+)/i.exec(contentType);
  return {
    contentType,
    charset: charsetMatch ? charsetMatch[1].trim().replace(/^"|"$/g, "") : "utf-8"
  };
}

export function concatArrayBuffers(chunks, maxBytes = Number.MAX_SAFE_INTEGER) {
  let total = 0;
  const bounded = [];
  let truncated = false;

  for (const chunk of chunks) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (bytes.byteLength > remaining) {
      bounded.push(bytes.slice(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }

    bounded.push(bytes);
    total += bytes.byteLength;
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const bytes of bounded) {
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }

  return { bytes: output, truncated };
}

export function hasBinarySignals(bytes) {
  const limit = Math.min(bytes.byteLength, 512);
  let suspiciousControlBytes = 0;

  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
    if ((bytes[index] < 0x09 || (bytes[index] > 0x0d && bytes[index] < 0x20) || bytes[index] === 0x7f)) {
      suspiciousControlBytes += 1;
    }
  }

  if (limit > 0 && suspiciousControlBytes > 8 && suspiciousControlBytes / limit > 0.05) {
    return true;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, limit));
  } catch {
    return true;
  }

  return false;
}

export function decodeText(bytes, charset = "utf-8") {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export async function sha256Hex(bytes) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    return undefined;
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function describeBody({
  bytes,
  totalBytes,
  truncated,
  headers = [],
  maxPreviewChars = DEFAULT_PREVIEW_CHARS
}) {
  const capturedBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const { contentType, charset } = parseContentType(headers);
  const contentEncoding = getHeader(headers, "content-encoding");
  const byteLength = Number.isFinite(totalBytes) ? totalBytes : capturedBytes.byteLength;

  const base = {
    kind: BODY_KIND.UNKNOWN,
    byteLength,
    capturedByteLength: capturedBytes.byteLength,
    truncated: Boolean(truncated),
    sha256: await sha256Hex(capturedBytes),
    charset,
    contentEncoding: contentEncoding || undefined,
    preview: ""
  };

  if (capturedBytes.byteLength === 0 && byteLength === 0) {
    return { ...base, kind: BODY_KIND.NONE };
  }

  if (contentEncoding && !/^identity$/i.test(contentEncoding)) {
    return {
      ...base,
      kind: BODY_KIND.BINARY,
      preview: `[${contentEncoding} encoded body sample: ${capturedBytes.byteLength} bytes]`
    };
  }

  if (hasBinarySignals(capturedBytes) && !TEXT_CONTENT_TYPE_PATTERN.test(contentType)) {
    return {
      ...base,
      kind: BODY_KIND.BINARY,
      preview: `[binary body sample: ${capturedBytes.byteLength} bytes]`
    };
  }

  const text = decodeText(capturedBytes, charset);
  const trimmed = text.trimStart();
  let kind = BODY_KIND.TEXT;

  if (JSON_CONTENT_TYPE_PATTERN.test(contentType) || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    kind = BODY_KIND.JSON;
  } else if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    kind = BODY_KIND.FORM;
  } else if (/multipart\/form-data/i.test(contentType)) {
    kind = BODY_KIND.MULTIPART;
  }

  return {
    ...base,
    kind,
    preview: text.slice(0, maxPreviewChars)
  };
}
