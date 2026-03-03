import { isAbsolute, resolve, relative, extname } from "node:path";
import { normalizePath } from "vite";
import { IMPORT_PROTECTION_DEBUG_FILTER, IMPORT_PROTECTION_DEBUG, KNOWN_SOURCE_EXTENSIONS } from "./constants.js";
function dedupePatterns(patterns) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const p of patterns) {
    const key = typeof p === "string" ? `s:${p}` : `r:${p.toString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
function stripQueryAndHash(id) {
  const q = id.indexOf("?");
  const h = id.indexOf("#");
  if (q === -1 && h === -1) return id;
  if (q === -1) return id.slice(0, h);
  if (h === -1) return id.slice(0, q);
  return id.slice(0, Math.min(q, h));
}
const normalizeFilePathCache = /* @__PURE__ */ new Map();
function normalizeFilePath(id) {
  let result = normalizeFilePathCache.get(id);
  if (result === void 0) {
    result = normalizePath(stripQueryAndHash(id));
    normalizeFilePathCache.set(id, result);
  }
  return result;
}
function clearNormalizeFilePathCache() {
  normalizeFilePathCache.clear();
}
const importSourceRe = /\bfrom\s+(?:"([^"]+)"|'([^']+)')|import\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g;
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function getOrCreate(map, key, factory) {
  let value = map.get(key);
  if (value === void 0) {
    value = factory();
    map.set(key, value);
  }
  return value;
}
function relativizePath(p, root) {
  if (!p.startsWith(root)) return p;
  const ch = p.charCodeAt(root.length);
  if (ch !== 47 && !Number.isNaN(ch)) return p;
  return ch === 47 ? p.slice(root.length + 1) : p.slice(root.length);
}
function extractImportSources(code) {
  const sources = [];
  let m;
  importSourceRe.lastIndex = 0;
  while ((m = importSourceRe.exec(code)) !== null) {
    const src = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (src) sources.push(src);
  }
  return sources;
}
function debugLog(...args) {
  if (!IMPORT_PROTECTION_DEBUG) return;
  console.warn("[import-protection:debug]", ...args);
}
function matchesDebugFilter(...values) {
  const debugFilter = IMPORT_PROTECTION_DEBUG_FILTER;
  if (!debugFilter) return true;
  return values.some((v) => v.includes(debugFilter));
}
function stripQuery(id) {
  const queryIndex = id.indexOf("?");
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}
function withoutKnownExtension(id) {
  const ext = extname(id);
  return KNOWN_SOURCE_EXTENSIONS.has(ext) ? id.slice(0, -ext.length) : id;
}
function isInsideDirectory(filePath, directory) {
  const rel = relative(resolve(directory), resolve(filePath));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
function shouldDeferViolation(opts) {
  return opts.isBuild || opts.isDevMock;
}
function buildSourceCandidates(source, resolved, root) {
  const candidates = /* @__PURE__ */ new Set();
  const push = (value) => {
    if (!value) return;
    candidates.add(value);
    candidates.add(stripQuery(value));
    candidates.add(withoutKnownExtension(stripQuery(value)));
  };
  push(source);
  if (resolved) {
    push(resolved);
    const relativeResolved = relativizePath(resolved, root);
    push(relativeResolved);
    push(`./${relativeResolved}`);
    push(`/${relativeResolved}`);
  }
  return candidates;
}
function buildResolutionCandidates(id) {
  const normalized = normalizeFilePath(id);
  const stripped = stripQuery(normalized);
  return [.../* @__PURE__ */ new Set([id, normalized, stripped])];
}
function canonicalizeResolvedId(id, root, resolveExtensionlessAbsoluteId) {
  const stripped = stripQuery(id);
  let normalized = normalizeFilePath(stripped);
  if (!isAbsolute(normalized) && !normalized.startsWith(".") && !normalized.startsWith("\0") && !/^[a-zA-Z]+:/.test(normalized)) {
    normalized = normalizeFilePath(resolve(root, normalized));
  }
  return resolveExtensionlessAbsoluteId(normalized);
}
export {
  buildResolutionCandidates,
  buildSourceCandidates,
  canonicalizeResolvedId,
  clearNormalizeFilePathCache,
  debugLog,
  dedupePatterns,
  escapeRegExp,
  extractImportSources,
  getOrCreate,
  isInsideDirectory,
  matchesDebugFilter,
  normalizeFilePath,
  relativizePath,
  shouldDeferViolation,
  stripQuery,
  stripQueryAndHash,
  withoutKnownExtension
};
//# sourceMappingURL=utils.js.map
