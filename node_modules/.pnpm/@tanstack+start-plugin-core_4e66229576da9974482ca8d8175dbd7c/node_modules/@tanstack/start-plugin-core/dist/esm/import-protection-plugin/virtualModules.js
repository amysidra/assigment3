import { resolveViteId } from "../utils.js";
import { VITE_ENVIRONMENT_NAMES } from "../constants.js";
import { isValidExportName } from "./rewriteDeniedImports.js";
import { CLIENT_ENV_SUGGESTIONS } from "./trace.js";
import { VITE_BROWSER_VIRTUAL_PREFIX } from "./constants.js";
import { relativizePath } from "./utils.js";
const MOCK_MODULE_ID = "tanstack-start-import-protection:mock";
const RESOLVED_MOCK_MODULE_ID = resolveViteId(MOCK_MODULE_ID);
const MOCK_BUILD_PREFIX = "tanstack-start-import-protection:mock:build:";
const RESOLVED_MOCK_BUILD_PREFIX = resolveViteId(MOCK_BUILD_PREFIX);
const MOCK_EDGE_PREFIX = "tanstack-start-import-protection:mock-edge:";
const RESOLVED_MOCK_EDGE_PREFIX = resolveViteId(MOCK_EDGE_PREFIX);
const MOCK_RUNTIME_PREFIX = "tanstack-start-import-protection:mock-runtime:";
const RESOLVED_MOCK_RUNTIME_PREFIX = resolveViteId(MOCK_RUNTIME_PREFIX);
const MARKER_PREFIX = "tanstack-start-import-protection:marker:";
const RESOLVED_MARKER_PREFIX = resolveViteId(MARKER_PREFIX);
const RESOLVED_MARKER_SERVER_ONLY = resolveViteId(`${MARKER_PREFIX}server-only`);
const RESOLVED_MARKER_CLIENT_ONLY = resolveViteId(`${MARKER_PREFIX}client-only`);
function resolvedMarkerVirtualModuleId(kind) {
  return kind === "server" ? RESOLVED_MARKER_SERVER_ONLY : RESOLVED_MARKER_CLIENT_ONLY;
}
function getResolvedVirtualModuleMatchers() {
  return RESOLVED_VIRTUAL_MODULE_MATCHERS;
}
const RESOLVED_VIRTUAL_MODULE_MATCHERS = [
  RESOLVED_MOCK_MODULE_ID,
  RESOLVED_MOCK_BUILD_PREFIX,
  RESOLVED_MOCK_EDGE_PREFIX,
  RESOLVED_MOCK_RUNTIME_PREFIX,
  RESOLVED_MARKER_PREFIX
];
const RESOLVE_PREFIX_PAIRS = [
  [MOCK_EDGE_PREFIX, RESOLVED_MOCK_EDGE_PREFIX],
  [MOCK_RUNTIME_PREFIX, RESOLVED_MOCK_RUNTIME_PREFIX],
  [MOCK_BUILD_PREFIX, RESOLVED_MOCK_BUILD_PREFIX],
  [MARKER_PREFIX, RESOLVED_MARKER_PREFIX]
];
function resolveInternalVirtualModuleId(source) {
  if (source.startsWith(VITE_BROWSER_VIRTUAL_PREFIX)) {
    return resolveInternalVirtualModuleId(
      `\0${source.slice(VITE_BROWSER_VIRTUAL_PREFIX.length)}`
    );
  }
  if (source === MOCK_MODULE_ID || source === RESOLVED_MOCK_MODULE_ID) {
    return RESOLVED_MOCK_MODULE_ID;
  }
  for (const [unresolvedPrefix, resolvedPrefix] of RESOLVE_PREFIX_PAIRS) {
    if (source.startsWith(unresolvedPrefix)) {
      return resolveViteId(source);
    }
    if (source.startsWith(resolvedPrefix)) {
      return source;
    }
  }
  return void 0;
}
function toBase64Url(input) {
  return Buffer.from(input, "utf8").toString("base64url");
}
function fromBase64Url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}
const RUNTIME_SUGGESTION_TEXT = "Fix: " + CLIENT_ENV_SUGGESTIONS.join(". ") + '. To disable these runtime diagnostics, set importProtection.mockAccess: "off".';
function mockRuntimeModuleIdFromViolation(info, mode, root) {
  if (mode === "off") return MOCK_MODULE_ID;
  if (info.env !== VITE_ENVIRONMENT_NAMES.client) return MOCK_MODULE_ID;
  const rel = (p) => relativizePath(p, root);
  const trace = info.trace.map((s) => {
    const file = rel(s.file);
    if (s.line == null) return file;
    return `${file}:${s.line}:${s.column ?? 1}`;
  });
  const payload = {
    env: info.env,
    importer: info.importer,
    specifier: info.specifier,
    trace,
    mode
  };
  return `${MOCK_RUNTIME_PREFIX}${toBase64Url(JSON.stringify(payload))}`;
}
function makeMockEdgeModuleId(exports, runtimeId) {
  const payload = { exports, runtimeId };
  return `${MOCK_EDGE_PREFIX}${toBase64Url(JSON.stringify(payload))}`;
}
function generateMockCode(diagnostics) {
  const fnName = diagnostics ? "__createMock" : "createMock";
  const hasDiag = !!diagnostics;
  const preamble = hasDiag ? `const __meta = ${JSON.stringify(diagnostics.meta)};
const __mode = ${JSON.stringify(diagnostics.mode)};

const __seen = new Set();
function __report(action, accessPath) {
  if (__mode === 'off') return;
  const key = action + ':' + accessPath;
  if (__seen.has(key)) return;
  __seen.add(key);

  const traceLines = Array.isArray(__meta.trace) && __meta.trace.length
    ? "\\n\\nTrace:\\n" + __meta.trace.map((t, i) => '  ' + (i + 1) + '. ' + String(t)).join('\\n')
    : '';

  const msg =
    '[import-protection] Mocked import used in dev client\\n\\n' +
    'Denied import: "' + __meta.specifier + '"\\n' +
    'Importer: ' + __meta.importer + '\\n' +
    'Access: ' + accessPath + ' (' + action + ')' +
    traceLines +
    '\\n\\n' + ${JSON.stringify(RUNTIME_SUGGESTION_TEXT)};

  const err = new Error(msg);
  if (__mode === 'warn') {
    console.warn(err);
  } else {
    console.error(err);
  }
}
` : "";
  const diagGetTraps = hasDiag ? `
      if (prop === Symbol.toPrimitive) {
        return () => {
          __report('toPrimitive', name);
          return '[import-protection mock]';
        };
      }
      if (prop === 'toString' || prop === 'valueOf' || prop === 'toJSON') {
        return () => {
          __report(String(prop), name);
          return '[import-protection mock]';
        };
      }` : "";
  const applyBody = hasDiag ? `__report('call', name + '()');
      return ${fnName}(name + '()');` : `return ${fnName}(name + '()');`;
  const constructBody = hasDiag ? `__report('construct', 'new ' + name);
      return ${fnName}('new ' + name);` : `return ${fnName}('new ' + name);`;
  const setTrap = hasDiag ? `
    set(_target, prop) {
      __report('set', name + '.' + String(prop));
      return true;
    },` : "";
  return `
${preamble}/* @__NO_SIDE_EFFECTS__ */
function ${fnName}(name) {
  const fn = function () {};
  fn.prototype.name = name;
  const children = Object.create(null);
  const proxy = new Proxy(fn, {
    get(_target, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'default') return proxy;
      if (prop === 'caller') return null;
      if (prop === 'then') return (f) => Promise.resolve(f(proxy));
      if (prop === 'catch') return () => Promise.resolve(proxy);
      if (prop === 'finally') return (f) => { f(); return Promise.resolve(proxy); };${diagGetTraps}
      if (typeof prop === 'symbol') return undefined;
      if (!(prop in children)) {
        children[prop] = ${fnName}(name + '.' + prop);
      }
      return children[prop];
    },
    apply() {
      ${applyBody}
    },
    construct() {
      ${constructBody}
    },${setTrap}
  });
  return proxy;
}
const mock = /* @__PURE__ */ ${fnName}('mock');
export default mock;
`;
}
function loadSilentMockModule() {
  return { code: generateMockCode() };
}
function filterExportNames(exports) {
  return exports.filter((n) => n.length > 0 && n !== "default");
}
function generateExportLines(names) {
  const lines = [];
  const stringExports = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (isValidExportName(n)) {
      lines.push(`export const ${n} = mock.${n};`);
    } else {
      const alias = `__tss_str_${i}`;
      lines.push(`const ${alias} = mock[${JSON.stringify(n)}];`);
      stringExports.push({ alias, name: n });
    }
  }
  if (stringExports.length > 0) {
    const reexports = stringExports.map((s) => `${s.alias} as ${JSON.stringify(s.name)}`).join(", ");
    lines.push(`export { ${reexports} };`);
  }
  return lines;
}
function generateSelfContainedMockModule(exportNames) {
  const mockCode = generateMockCode();
  const exportLines = generateExportLines(filterExportNames(exportNames));
  return {
    code: `${mockCode}
${exportLines.join("\n")}
`
  };
}
function generateDevSelfDenialModule(exportNames, runtimeId) {
  const names = filterExportNames(exportNames);
  const exportLines = generateExportLines(names);
  return {
    code: `import mock from ${JSON.stringify(runtimeId)};
${exportLines.join("\n")}
export default mock;
`
  };
}
function loadMockEdgeModule(encodedPayload) {
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload));
  } catch {
    payload = { exports: [] };
  }
  const names = filterExportNames(payload.exports ?? []);
  const runtimeId = typeof payload.runtimeId === "string" && payload.runtimeId.length > 0 ? payload.runtimeId : MOCK_MODULE_ID;
  const exportLines = generateExportLines(names);
  return {
    code: `import mock from ${JSON.stringify(runtimeId)};
${exportLines.join("\n")}
export default mock;
`
  };
}
function loadMockRuntimeModule(encodedPayload) {
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload));
  } catch {
    payload = {};
  }
  const mode = payload.mode === "warn" || payload.mode === "off" ? payload.mode : "error";
  const meta = {
    env: String(payload.env ?? ""),
    importer: String(payload.importer ?? ""),
    specifier: String(payload.specifier ?? ""),
    trace: Array.isArray(payload.trace) ? payload.trace : []
  };
  return { code: generateMockCode({ meta, mode }) };
}
const MARKER_MODULE_RESULT = { code: "export {}" };
function loadMarkerModule() {
  return MARKER_MODULE_RESULT;
}
function loadResolvedVirtualModule(id) {
  if (id === RESOLVED_MOCK_MODULE_ID) {
    return loadSilentMockModule();
  }
  if (id.startsWith(RESOLVED_MOCK_BUILD_PREFIX)) {
    return loadSilentMockModule();
  }
  if (id.startsWith(RESOLVED_MOCK_EDGE_PREFIX)) {
    return loadMockEdgeModule(id.slice(RESOLVED_MOCK_EDGE_PREFIX.length));
  }
  if (id.startsWith(RESOLVED_MOCK_RUNTIME_PREFIX)) {
    return loadMockRuntimeModule(id.slice(RESOLVED_MOCK_RUNTIME_PREFIX.length));
  }
  if (id.startsWith(RESOLVED_MARKER_PREFIX)) {
    return loadMarkerModule();
  }
  return void 0;
}
export {
  MOCK_BUILD_PREFIX,
  MOCK_EDGE_PREFIX,
  MOCK_MODULE_ID,
  MOCK_RUNTIME_PREFIX,
  RUNTIME_SUGGESTION_TEXT,
  generateDevSelfDenialModule,
  generateSelfContainedMockModule,
  getResolvedVirtualModuleMatchers,
  loadMarkerModule,
  loadMockEdgeModule,
  loadMockRuntimeModule,
  loadResolvedVirtualModule,
  loadSilentMockModule,
  makeMockEdgeModuleId,
  mockRuntimeModuleIdFromViolation,
  resolveInternalVirtualModuleId,
  resolvedMarkerVirtualModuleId
};
//# sourceMappingURL=virtualModules.js.map
