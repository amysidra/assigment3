import { relativizePath, getOrCreate } from "./utils.js";
class ImportGraph {
  /**
   * resolvedId -> Map<importer, specifier>
   *
   * We use a Map instead of a Set of objects so edges dedupe correctly.
   */
  reverseEdges = /* @__PURE__ */ new Map();
  /**
   * Forward-edge index: importer -> Set<resolvedId>.
   *
   * Maintained alongside reverseEdges so that {@link invalidate} can remove
   * all outgoing edges for a file in O(outgoing-edges) instead of scanning
   * every reverse-edge map in the graph.
   */
  forwardEdges = /* @__PURE__ */ new Map();
  entries = /* @__PURE__ */ new Set();
  addEdge(resolved, importer, specifier) {
    getOrCreate(this.reverseEdges, resolved, () => /* @__PURE__ */ new Map()).set(
      importer,
      specifier
    );
    getOrCreate(this.forwardEdges, importer, () => /* @__PURE__ */ new Set()).add(resolved);
  }
  /** Convenience for tests/debugging. */
  getEdges(resolved) {
    const importers = this.reverseEdges.get(resolved);
    if (!importers) return void 0;
    const out = /* @__PURE__ */ new Set();
    for (const [importer, specifier] of importers) {
      out.add({ importer, specifier });
    }
    return out;
  }
  addEntry(id) {
    this.entries.add(id);
  }
  clear() {
    this.reverseEdges.clear();
    this.forwardEdges.clear();
    this.entries.clear();
  }
  invalidate(id) {
    const targets = this.forwardEdges.get(id);
    if (targets) {
      for (const resolved of targets) {
        this.reverseEdges.get(resolved)?.delete(id);
      }
      this.forwardEdges.delete(id);
    }
    this.reverseEdges.delete(id);
  }
}
function buildTrace(graph, startNode, maxDepth = 20) {
  const visited = /* @__PURE__ */ new Set([startNode]);
  const depthByNode = /* @__PURE__ */ new Map([[startNode, 0]]);
  const down = /* @__PURE__ */ new Map();
  const queue = [startNode];
  let qi = 0;
  let root = null;
  while (qi < queue.length) {
    const node = queue[qi++];
    const depth = depthByNode.get(node);
    const importers = graph.reverseEdges.get(node);
    if (node !== startNode) {
      const isEntry = graph.entries.has(node) || !importers || importers.size === 0;
      if (isEntry) {
        root = node;
        break;
      }
    }
    if (depth >= maxDepth) {
      continue;
    }
    if (!importers || importers.size === 0) {
      continue;
    }
    for (const [importer, specifier] of importers) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      depthByNode.set(importer, depth + 1);
      down.set(importer, { next: node, specifier });
      queue.push(importer);
    }
  }
  if (!root) {
    root = startNode;
  }
  const trace = [];
  let current = root;
  for (let i = 0; i <= maxDepth + 1; i++) {
    const link = down.get(current);
    trace.push({ file: current, specifier: link?.specifier });
    if (!link) break;
    current = link.next;
  }
  return trace;
}
const CLIENT_ENV_SUGGESTIONS = [
  "Use createServerFn().handler(() => ...) to keep the logic on the server and call it from the client via an RPC bridge",
  "Use createServerOnlyFn(() => ...) to mark it as server-only (it will throw if accidentally called from the client)",
  "Use createIsomorphicFn().client(() => ...).server(() => ...) to provide separate client and server implementations",
  "Move the server-only import out of this file into a separate .server.ts module that is not imported by any client code"
];
const SERVER_ENV_SUGGESTIONS = [
  "Use createClientOnlyFn(() => ...) to mark it as client-only (returns undefined on the server)",
  "Use createIsomorphicFn().client(() => ...).server(() => ...) to provide separate client and server implementations",
  "Move the client-only import out of this file into a separate .client.ts module that is not imported by any server code"
];
function formatViolation(info, root) {
  const rel = (p) => relativizePath(p, root);
  const relLoc = (p, loc) => {
    const r = rel(p);
    const file = loc?.file ? rel(loc.file) : r;
    return loc ? `${file}:${loc.line}:${loc.column}` : r;
  };
  const relTraceStep = (step) => {
    const file = rel(step.file);
    if (step.line == null) return file;
    const col = step.column ?? 1;
    return `${file}:${step.line}:${col}`;
  };
  const lines = [];
  lines.push(``);
  lines.push(`[import-protection] Import denied in ${info.envType} environment`);
  lines.push(``);
  if (info.type === "specifier") {
    lines.push(`  Denied by specifier pattern: ${String(info.pattern)}`);
  } else if (info.type === "file") {
    lines.push(`  Denied by file pattern: ${String(info.pattern)}`);
  } else {
    lines.push(
      `  Denied by marker: module is restricted to the opposite environment`
    );
  }
  lines.push(`  Importer: ${relLoc(info.importer, info.importerLoc)}`);
  lines.push(`  Import: "${rel(info.specifier)}"`);
  if (info.resolved) {
    lines.push(`  Resolved: ${rel(info.resolved)}`);
  }
  if (info.trace.length > 0) {
    lines.push(``);
    lines.push(`  Trace:`);
    for (let i = 0; i < info.trace.length; i++) {
      const step = info.trace[i];
      const isEntry = i === 0;
      const tag = isEntry ? " (entry)" : "";
      const spec = step.specifier ? ` (import "${rel(step.specifier)}")` : "";
      lines.push(`    ${i + 1}. ${relTraceStep(step)}${tag}${spec}`);
    }
  }
  if (info.snippet) {
    lines.push(``);
    lines.push(`  Code:`);
    for (const snippetLine of info.snippet.lines) {
      lines.push(snippetLine);
    }
    lines.push(``);
    lines.push(`  ${rel(info.snippet.location)}`);
  }
  lines.push(``);
  if (info.envType === "client") {
    lines.push(`  Suggestions:`);
    for (const s of CLIENT_ENV_SUGGESTIONS) {
      lines.push(`    - ${s}`);
    }
  } else {
    const snippetText = info.snippet?.lines.join("\n") ?? "";
    const looksLikeJsx = /<[A-Z]/.test(snippetText) || /\{.*\(.*\).*\}/.test(snippetText) && /</.test(snippetText);
    lines.push(`  Suggestions:`);
    if (looksLikeJsx) {
      lines.push(
        `    - Wrap the JSX in <ClientOnly fallback={<Loading />}>...</ClientOnly> so it only renders in the browser after hydration`
      );
    }
    for (const s of SERVER_ENV_SUGGESTIONS) {
      lines.push(`    - ${s}`);
    }
  }
  lines.push(``);
  return lines.join("\n");
}
export {
  CLIENT_ENV_SUGGESTIONS,
  ImportGraph,
  SERVER_ENV_SUGGESTIONS,
  buildTrace,
  formatViolation
};
//# sourceMappingURL=trace.js.map
