import { SERVER_FN_LOOKUP } from "../constants.js";
const SERVER_FN_LOOKUP_QUERY = `?${SERVER_FN_LOOKUP}`;
const IMPORT_PROTECTION_DEBUG = process.env.TSR_IMPORT_PROTECTION_DEBUG === "1" || process.env.TSR_IMPORT_PROTECTION_DEBUG === "true";
const IMPORT_PROTECTION_DEBUG_FILTER = process.env.TSR_IMPORT_PROTECTION_DEBUG_FILTER;
const KNOWN_SOURCE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json"
]);
const VITE_BROWSER_VIRTUAL_PREFIX = "/@id/__x00__";
export {
  IMPORT_PROTECTION_DEBUG,
  IMPORT_PROTECTION_DEBUG_FILTER,
  KNOWN_SOURCE_EXTENSIONS,
  SERVER_FN_LOOKUP_QUERY,
  VITE_BROWSER_VIRTUAL_PREFIX
};
//# sourceMappingURL=constants.js.map
