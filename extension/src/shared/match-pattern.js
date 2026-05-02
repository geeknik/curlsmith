export function isHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function originPatternFromUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https origins can be captured.");
  }
  return `${url.origin}/*`;
}

export function hostFromUrl(rawUrl) {
  return new URL(rawUrl).host;
}

export function parseApprovedOriginPattern(pattern) {
  if (pattern === "<all_urls>") {
    return { allUrls: true };
  }

  const match = /^(https?|\*):\/\/(\*\.)?([^/*]+)\/\*$/.exec(pattern);
  if (!match) {
    return null;
  }

  return {
    scheme: match[1],
    wildcardSubdomains: Boolean(match[2]),
    host: match[3].toLowerCase()
  };
}

export function matchesApprovedOrigin(pattern, rawUrl) {
  const parsed = parseApprovedOriginPattern(pattern);
  if (!parsed) {
    return false;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  if (parsed.allUrls) {
    return true;
  }

  const scheme = url.protocol.slice(0, -1);
  if (parsed.scheme !== "*" && parsed.scheme !== scheme) {
    return false;
  }

  const host = url.hostname.toLowerCase();
  if (parsed.wildcardSubdomains) {
    return host === parsed.host || host.endsWith(`.${parsed.host}`);
  }

  return host === parsed.host;
}

export function isUrlApproved(patterns, rawUrl) {
  return patterns.some((pattern) => matchesApprovedOrigin(pattern, rawUrl));
}
