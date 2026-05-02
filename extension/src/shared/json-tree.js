const MAX_STRING_CHARS = 240;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalarPreview(value) {
  if (typeof value === "string") {
    const clipped = value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}...`
      : value;
    return JSON.stringify(clipped);
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === undefined) {
    return "undefined";
  }
  return `[${typeof value}]`;
}

function childEntries(value) {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item]);
  }

  if (!isObject(value)) {
    return [];
  }

  return Object.entries(value).filter(([key]) => {
    return key !== "__proto__" && key !== "constructor" && key !== "prototype";
  });
}

function containerPreview(value) {
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (isObject(value)) {
    return `Object(${childEntries(value).length})`;
  }
  return scalarPreview(value);
}

export function jsonTreeRows(value, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 8;
  const maxNodes = Number.isInteger(options.maxNodes) ? options.maxNodes : 1000;
  const rows = [];
  const stack = [{
    value,
    key: "$",
    path: "$",
    depth: 0
  }];
  let visited = 0;

  while (stack.length > 0) {
    const item = stack.pop();
    visited += 1;

    if (visited > maxNodes) {
      rows.push({
        depth: item.depth,
        key: "...",
        path: item.path,
        kind: "truncated",
        preview: `Tree truncated at ${maxNodes} nodes`
      });
      break;
    }

    const entries = childEntries(item.value);
    const isContainer = entries.length > 0;
    rows.push({
      depth: item.depth,
      key: item.key,
      path: item.path,
      kind: Array.isArray(item.value) ? "array" : isObject(item.value) ? "object" : typeof item.value,
      preview: containerPreview(item.value)
    });

    if (!isContainer || item.depth >= maxDepth) {
      if (isContainer && item.depth >= maxDepth) {
        rows.push({
          depth: item.depth + 1,
          key: "...",
          path: item.path,
          kind: "truncated",
          preview: `Max depth ${maxDepth} reached`
        });
      }
      continue;
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      const childPath = Array.isArray(item.value)
        ? `${item.path}[${key}]`
        : `${item.path}.${key}`;
      stack.push({
        value: child,
        key,
        path: childPath,
        depth: item.depth + 1
      });
    }
  }

  return rows;
}

export function jsonTreeRowsFromText(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }

  return jsonTreeRows(JSON.parse(text), options);
}
