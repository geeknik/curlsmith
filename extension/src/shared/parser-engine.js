const ENTITY_TYPES = Object.freeze(["user", "post", "comment", "message", "media"]);

const STRONG_KEYS = Object.freeze({
  user: ["user", "username", "handle", "screen_name", "displayname", "profile"],
  post: ["post", "title", "body", "content", "author", "created_at"],
  comment: ["comment", "body", "parent_id", "thread", "reply"],
  message: ["message", "text", "sender", "recipient", "conversation"],
  media: ["media", "image", "video", "thumbnail", "url"]
});

const SUPPORTING_KEYS = Object.freeze({
  user: ["avatar", "bio", "followers", "user_id"],
  post: ["score", "likes", "permalink", "url"],
  comment: ["depth", "replies", "author"],
  message: ["timestamp", "read", "channel"],
  media: ["width", "height", "duration"]
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value) {
  if (typeof value === "string") {
    return value.slice(0, 4096);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function getAny(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = safeString(source[key]);
      if (value !== undefined && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

function scoreType(object, type) {
  const keys = new Set(Object.keys(object).map((key) => key.toLowerCase()));
  let score = 0;

  for (const key of STRONG_KEYS[type]) {
    if (keys.has(key)) {
      score += 2;
    }
  }

  for (const key of SUPPORTING_KEYS[type]) {
    if (keys.has(key)) {
      score += 1;
    }
  }

  return score;
}

function classifyEntity(object) {
  let bestType = "unknown";
  let bestScore = 0;

  for (const type of ENTITY_TYPES) {
    const score = scoreType(object, type);
    if (score > bestScore) {
      bestType = type;
      bestScore = score;
    }
  }

  if (bestScore < 2) {
    return { type: "unknown", confidence: 0 };
  }

  return {
    type: bestType,
    confidence: Math.min(0.95, 0.35 + bestScore * 0.12)
  };
}

function normalizeEntity({ object, type, confidence, capture, path }) {
  const externalId = getAny(object, ["id", `${type}_id`, "uuid", "slug"]);
  const text = getAny(object, ["text", "body", "content", "message", "description"]);
  const title = getAny(object, ["title", "headline", "name"]);
  const author = getAny(object, ["author", "username", "handle", "sender"]);
  const displayName = getAny(object, ["displayName", "display_name", "name", "username"]);
  const createdAt = getAny(object, ["created_at", "createdAt", "timestamp", "date"]);
  const updatedAt = getAny(object, ["updated_at", "updatedAt"]);
  const url = getAny(object, ["url", "permalink", "href"]);

  const stable = [
    capture.id,
    type,
    externalId || "",
    path,
    text || title || displayName || ""
  ].join(":");

  return {
    id: `ent:${hashString(stable)}`,
    sourceCaptureId: capture.id,
    sourceHost: capture.request.host,
    sourceUrl: capture.request.url,
    type,
    externalId,
    parentExternalId: getAny(object, ["parent_id", "parentId", "thread_id"]),
    author,
    displayName,
    title,
    text,
    url,
    createdAt,
    updatedAt,
    rawPath: path,
    raw: object,
    confidence
  };
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function extractEntitiesFromJson(json, capture, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 12;
  const maxEntities = Number.isInteger(options.maxEntities) ? options.maxEntities : 5000;
  const rootPath = typeof options.rootPath === "string" ? options.rootPath : "$";
  const entities = [];
  const seenIds = new Set();
  const stack = [{ value: json, path: rootPath, depth: 0 }];
  let inspected = 0;

  while (stack.length > 0 && entities.length < maxEntities) {
    const item = stack.pop();
    inspected += 1;
    if (inspected > maxEntities * 20) {
      break;
    }

    if (item.depth > maxDepth) {
      continue;
    }

    if (Array.isArray(item.value)) {
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: item.value[index],
          path: `${item.path}[${index}]`,
          depth: item.depth + 1
        });
      }
      continue;
    }

    if (!isObject(item.value)) {
      continue;
    }

    const classification = classifyEntity(item.value);
    if (classification.type !== "unknown") {
      const entity = normalizeEntity({
        object: item.value,
        type: classification.type,
        confidence: classification.confidence,
        capture,
        path: item.path
      });
      if (!seenIds.has(entity.id)) {
        entities.push(entity);
        seenIds.add(entity.id);
      }
    }

    for (const [key, value] of Object.entries(item.value).reverse()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      if (Array.isArray(value) || isObject(value)) {
        stack.push({
          value,
          path: `${item.path}.${key}`,
          depth: item.depth + 1
        });
      }
    }
  }

  return entities;
}

export function extractEntitiesFromText(text, capture, options = {}) {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }

  try {
    return extractEntitiesFromJson(JSON.parse(text), capture, options);
  } catch {
    return extractEntitiesFromNdjson(text, capture, options);
  }
}

export function extractEntitiesFromNdjson(text, capture, options = {}) {
  const maxEntities = Number.isInteger(options.maxEntities) ? options.maxEntities : 5000;
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 10000;
  const entities = [];
  const seenIds = new Set();
  const lines = text.split(/\r?\n/);

  if (lines.length > maxLines) {
    return [];
  }

  for (let index = 0; index < lines.length && entities.length < maxEntities; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }

    const lineEntities = extractEntitiesFromJson(parsed, capture, {
      ...options,
      maxEntities: maxEntities - entities.length,
      rootPath: `$[${index}]`
    });

    for (const entity of lineEntities) {
      if (!seenIds.has(entity.id)) {
        entities.push(entity);
        seenIds.add(entity.id);
      }
    }
  }

  return entities;
}
