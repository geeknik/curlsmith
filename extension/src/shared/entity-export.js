import { isTokenLike } from "./redactor.js";

export const ENTITY_EXPORT_FIELDS = Object.freeze([
  "id",
  "sourceCaptureId",
  "sourceHost",
  "sourceUrl",
  "type",
  "externalId",
  "parentExternalId",
  "author",
  "displayName",
  "title",
  "text",
  "url",
  "createdAt",
  "updatedAt",
  "rawPath",
  "confidence"
]);

function safeExportText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value).slice(0, 8192);
  return text
    .split(/(\s+)/)
    .map((part) => isTokenLike(part) ? "<REDACTED>" : part)
    .join("");
}

export function normalizeEntityForExport(entity) {
  const output = {};
  for (const field of ENTITY_EXPORT_FIELDS) {
    if (field === "confidence") {
      output[field] = Number.isFinite(entity[field]) ? Number(entity[field].toFixed(3)) : "";
    } else {
      output[field] = safeExportText(entity[field]);
    }
  }
  return output;
}

export function entitiesToJsonl(entities) {
  return entities
    .map((entity) => JSON.stringify(normalizeEntityForExport(entity)))
    .join("\n") + (entities.length > 0 ? "\n" : "");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

export function entitiesToCsv(entities) {
  const rows = [ENTITY_EXPORT_FIELDS.join(",")];
  for (const entity of entities) {
    const normalized = normalizeEntityForExport(entity);
    rows.push(ENTITY_EXPORT_FIELDS.map((field) => csvEscape(normalized[field])).join(","));
  }
  return rows.join("\n") + "\n";
}
