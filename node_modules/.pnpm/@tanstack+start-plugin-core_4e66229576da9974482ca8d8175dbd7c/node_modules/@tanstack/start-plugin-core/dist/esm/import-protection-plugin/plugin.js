import { normalizePath } from "vite";
import { resolveViteId } from "../utils.js";
import { VITE_ENVIRONMENT_NAMES } from "../constants.js";
import { formatViolation, ImportGraph, buildTrace } from "./trace.js";
import { getDefaultImportProtectionRules, getMarkerSpecifiers } from "./defaults.js";
import { matchesAny, compileMatchers } from "./matchers.js";
import { normalizeFilePath, matchesDebugFilter, debugLog, escapeRegExp, getOrCreate, clearNormalizeFilePathCache, shouldDeferViolation, dedupePatterns, relativizePath, extractImportSources, canonicalizeResolvedId, isInsideDirectory, buildSourceCandidates, buildResolutionCandidates } from "./utils.js";
import { collectNamedExports, rewriteDeniedImports, collectMockExportNamesBySource } from "./rewriteDeniedImports.js";
import { loadResolvedVirtualModule, getResolvedVirtualModuleMatchers, resolveInternalVirtualModuleId, resolvedMarkerVirtualModuleId, generateSelfContainedMockModule, mockRuntimeModuleIdFromViolation, generateDevSelfDenialModule, MOCK_BUILD_PREFIX, makeMockEdgeModuleId } from "./virtualModules.js";
import { ExtensionlessAbsoluteIdResolver } from "./extensionlessAbsoluteIdResolver.js";
import { IMPORT_PROTECTION_DEBUG, SERVER_FN_LOOKUP_QUERY, VITE_BROWSER_VIRTUAL_PREFIX } from "./constants.js";
import { pickOriginalCodeFromSourcesContent, buildLineIndex, ImportLocCache, buildCodeSnippet, findPostCompileUsageLocation, findImportStatementLocationFromTransformed, addTraceImportLocations } from "./sourceLocation.js";
function importProtectionPlugin(opts) {
  let devServer = null;
  const extensionlessIdResolver = new ExtensionlessAbsoluteIdResolver();
  const resolveExtensionlessAbsoluteId = (id) => extensionlessIdResolver.resolve(id);
  const importPatternCache = /* @__PURE__ */ new Map();
  function findFirstImportSpecifierIndex(code, source) {
    let patterns = importPatternCache.get(source);
    if (!patterns) {
      const escaped = escapeRegExp(source);
      patterns = [
        new RegExp(`\\bimport\\s+(['"])${escaped}\\1`),
        new RegExp(`\\bfrom\\s+(['"])${escaped}\\1`),
        new RegExp(`\\bimport\\s*\\(\\s*(['"])${escaped}\\1\\s*\\)`)
      ];
      importPatternCache.set(source, patterns);
    }
    let best = -1;
    for (const re of patterns) {
      const m = re.exec(code);
      if (!m) continue;
      const idx = m.index + m[0].indexOf(source);
      if (idx === -1) continue;
      if (best === -1 || idx < best) best = idx;
    }
    return best;
  }
  function buildTraceFromModuleGraph(envName, env, targetFile) {
    if (!devServer) return null;
    const environment = devServer.environments[envName];
    if (!environment) return null;
    const file = normalizeFilePath(targetFile);
    const start = environment.moduleGraph.getModuleById(file);
    if (!start) return null;
    const nodeIds = /* @__PURE__ */ new Map();
    function nodeId(n) {
      let cached = nodeIds.get(n);
      if (cached === void 0) {
        cached = n.id ? normalizeFilePath(n.id) : n.url ? normalizeFilePath(n.url) : "";
        nodeIds.set(n, cached);
      }
      return cached;
    }
    const queue = [start];
    const visited = /* @__PURE__ */ new Set([start]);
    const parent = /* @__PURE__ */ new Map();
    let entryRoot = null;
    let fallbackRoot = null;
    let qi = 0;
    while (qi < queue.length) {
      const node = queue[qi++];
      const id = nodeId(node);
      if (id && env.graph.entries.has(id)) {
        entryRoot = node;
        break;
      }
      const importers = node.importers;
      if (importers.size === 0) {
        if (!fallbackRoot) fallbackRoot = node;
        continue;
      }
      for (const imp of importers) {
        if (visited.has(imp)) continue;
        visited.add(imp);
        parent.set(imp, node);
        queue.push(imp);
      }
    }
    const root = entryRoot ?? fallbackRoot;
    if (!root) return null;
    const chain = [];
    let cur = root;
    for (let i = 0; i < config.maxTraceDepth + 2 && cur; i++) {
      chain.push(cur);
      if (cur === start) break;
      cur = parent.get(cur);
    }
    const steps = [];
    for (let i = 0; i < chain.length; i++) {
      const id = nodeId(chain[i]);
      if (!id) continue;
      let specifier;
      if (i + 1 < chain.length) {
        const nextId = nodeId(chain[i + 1]);
        if (nextId) {
          specifier = env.graph.reverseEdges.get(nextId)?.get(id);
        }
      }
      steps.push(specifier ? { file: id, specifier } : { file: id });
    }
    return steps.length ? steps : null;
  }
  const config = {
    enabled: true,
    root: "",
    command: "build",
    srcDirectory: "",
    framework: opts.framework,
    effectiveBehavior: "error",
    mockAccess: "error",
    logMode: "once",
    maxTraceDepth: 20,
    compiledRules: {
      client: { specifiers: [], files: [], excludeFiles: [] },
      server: { specifiers: [], files: [], excludeFiles: [] }
    },
    includeMatchers: [],
    excludeMatchers: [],
    ignoreImporterMatchers: [],
    markerSpecifiers: { serverOnly: /* @__PURE__ */ new Set(), clientOnly: /* @__PURE__ */ new Set() },
    envTypeMap: new Map(opts.environments.map((e) => [e.name, e.type])),
    onViolation: void 0
  };
  const envStates = /* @__PURE__ */ new Map();
  const shared = { fileMarkerKind: /* @__PURE__ */ new Map() };
  async function rebuildAndAnnotateTrace(provider, env, envName, normalizedImporter, specifier, importerLoc, traceOverride) {
    let trace = traceOverride ?? buildTrace(env.graph, normalizedImporter, config.maxTraceDepth);
    if (config.command === "serve") {
      const mgTrace = buildTraceFromModuleGraph(
        envName,
        env,
        normalizedImporter
      );
      if (mgTrace && mgTrace.length > trace.length) {
        trace = mgTrace;
      }
    }
    await addTraceImportLocations(
      provider,
      trace,
      env.importLocCache,
      findFirstImportSpecifierIndex
    );
    if (trace.length > 0) {
      const last = trace[trace.length - 1];
      if (!last.specifier) last.specifier = specifier;
      if (importerLoc && last.line == null) {
        last.line = importerLoc.line;
        last.column = importerLoc.column;
      }
    }
    return trace;
  }
  async function buildViolationInfo(provider, env, envName, envType, importer, normalizedImporter, source, overrides, traceOverride) {
    const sourceCandidates = buildSourceCandidates(
      source,
      "resolved" in overrides && typeof overrides.resolved === "string" ? overrides.resolved : void 0,
      config.root
    );
    const loc = await resolveImporterLocation(
      provider,
      env,
      importer,
      sourceCandidates
    );
    const trace = await rebuildAndAnnotateTrace(
      provider,
      env,
      envName,
      normalizedImporter,
      source,
      loc,
      traceOverride
    );
    const snippet = loc ? buildCodeSnippet(provider, importer, loc) : void 0;
    return {
      env: envName,
      envType,
      behavior: config.effectiveBehavior,
      specifier: source,
      importer: normalizedImporter,
      ...loc ? { importerLoc: loc } : {},
      trace,
      snippet,
      ...overrides
    };
  }
  async function resolveImporterLocation(provider, env, importer, sourceCandidates) {
    for (const candidate of sourceCandidates) {
      const loc = await findPostCompileUsageLocation(provider, importer, candidate) || await findImportStatementLocationFromTransformed(
        provider,
        importer,
        candidate,
        env.importLocCache,
        findFirstImportSpecifierIndex
      );
      if (loc) return loc;
    }
    return void 0;
  }
  async function buildMarkerViolationFromResolvedImport(provider, env, envName, envType, importer, source, resolvedId, relativePath, traceOverride) {
    const normalizedResolvedId = normalizeFilePath(resolvedId);
    const markerKind = shared.fileMarkerKind.get(normalizedResolvedId);
    const violates = envType === "client" && markerKind === "server" || envType === "server" && markerKind === "client";
    if (!violates) return void 0;
    const normalizedImporter = normalizeFilePath(importer);
    return buildViolationInfo(
      provider,
      env,
      envName,
      envType,
      importer,
      normalizedImporter,
      source,
      {
        type: "marker",
        resolved: normalizedResolvedId,
        message: buildMarkerViolationMessage(relativePath, markerKind)
      },
      traceOverride
    );
  }
  function buildMarkerViolationMessage(relativePath, markerKind) {
    return markerKind === "server" ? `Module "${relativePath}" is marked server-only but is imported in the client environment` : `Module "${relativePath}" is marked client-only but is imported in the server environment`;
  }
  async function buildFileViolationInfo(provider, env, envName, envType, importer, normalizedImporter, source, resolvedPath, pattern, traceOverride) {
    const relativePath = getRelativePath(resolvedPath);
    return buildViolationInfo(
      provider,
      env,
      envName,
      envType,
      importer,
      normalizedImporter,
      source,
      {
        type: "file",
        pattern,
        resolved: resolvedPath,
        message: `Import "${source}" (resolved to "${relativePath}") is denied in the ${envType} environment`
      },
      traceOverride
    );
  }
  function getEnvType(envName) {
    return config.envTypeMap.get(envName) ?? "server";
  }
  function getRulesForEnvironment(envName) {
    const type = getEnvType(envName);
    return type === "client" ? config.compiledRules.client : config.compiledRules.server;
  }
  function checkFileDenial(relativePath, matchers) {
    if (matchers.excludeFiles.length > 0 && matchesAny(relativePath, matchers.excludeFiles)) {
      return void 0;
    }
    return matchers.files.length > 0 ? matchesAny(relativePath, matchers.files) : void 0;
  }
  const environmentNames = /* @__PURE__ */ new Set([
    VITE_ENVIRONMENT_NAMES.client,
    VITE_ENVIRONMENT_NAMES.server
  ]);
  if (opts.providerEnvName !== VITE_ENVIRONMENT_NAMES.server) {
    environmentNames.add(opts.providerEnvName);
  }
  function getEnv(envName) {
    let envState = envStates.get(envName);
    if (!envState) {
      const transformResultCache = /* @__PURE__ */ new Map();
      envState = {
        graph: new ImportGraph(),
        mockExportsByImporter: /* @__PURE__ */ new Map(),
        resolveCache: /* @__PURE__ */ new Map(),
        resolveCacheByFile: /* @__PURE__ */ new Map(),
        importLocCache: new ImportLocCache(),
        seenViolations: /* @__PURE__ */ new Set(),
        transformResultCache,
        transformResultKeysByFile: /* @__PURE__ */ new Map(),
        transformResultProvider: {
          getTransformResult(id) {
            const fullKey = normalizePath(id);
            const exact = transformResultCache.get(fullKey);
            if (exact) return exact;
            const strippedKey = normalizeFilePath(id);
            return strippedKey !== fullKey ? transformResultCache.get(strippedKey) : void 0;
          }
        },
        postTransformImports: /* @__PURE__ */ new Map(),
        serverFnLookupModules: /* @__PURE__ */ new Set(),
        pendingViolations: /* @__PURE__ */ new Map(),
        deferredBuildViolations: []
      };
      envStates.set(envName, envState);
    }
    return envState;
  }
  function findExportsInMap(exportMap, candidates) {
    for (const candidate of candidates) {
      const hit = exportMap.get(candidate);
      if (hit && hit.length > 0) return hit;
    }
    return [];
  }
  function buildIdCandidates(id, extra) {
    const set = new Set(buildResolutionCandidates(id));
    if (extra) {
      for (const c of buildResolutionCandidates(extra)) set.add(c);
      set.add(resolveExtensionlessAbsoluteId(extra));
    }
    return Array.from(set);
  }
  async function resolveExportsForDeniedSpecifier(env, ctx, info, importerIdHint) {
    const importerFile = normalizeFilePath(info.importer);
    const specifierCandidates = buildIdCandidates(info.specifier, info.resolved);
    let parsedBySource = env.mockExportsByImporter.get(importerFile);
    if (!parsedBySource) {
      const importerCode = env.transformResultProvider.getTransformResult(importerFile)?.code ?? (importerIdHint && ctx.getModuleInfo ? ctx.getModuleInfo(importerIdHint)?.code ?? void 0 : void 0);
      if (typeof importerCode !== "string" || importerCode.length === 0)
        return [];
      try {
        parsedBySource = collectMockExportNamesBySource(importerCode);
        await recordMockExportsForImporter(
          env,
          importerFile,
          parsedBySource,
          async (src) => {
            const cacheKey = `${importerFile}:${src}`;
            if (env.resolveCache.has(cacheKey)) {
              return env.resolveCache.get(cacheKey) ?? void 0;
            }
            if (!ctx.resolve) return void 0;
            const resolved = await ctx.resolve(src, info.importer, {
              skipSelf: true
            });
            if (!resolved || resolved.external) return void 0;
            return resolved.id;
          }
        );
        parsedBySource = env.mockExportsByImporter.get(importerFile) ?? parsedBySource;
      } catch {
        return [];
      }
    }
    const direct = findExportsInMap(parsedBySource, specifierCandidates);
    if (direct.length > 0) return direct;
    const candidateSet = new Set(specifierCandidates);
    for (const [sourceKey, names] of parsedBySource) {
      if (!names.length) continue;
      const resolvedId = await resolveSourceKey(
        env,
        ctx,
        importerFile,
        sourceKey,
        info.importer
      );
      if (!resolvedId) continue;
      const resolvedCandidates = buildIdCandidates(resolvedId);
      resolvedCandidates.push(resolveExtensionlessAbsoluteId(resolvedId));
      if (resolvedCandidates.some((v) => candidateSet.has(v))) {
        return names;
      }
    }
    return [];
  }
  async function resolveSourceKey(env, ctx, importerFile, sourceKey, importerId) {
    const cacheKey = `${importerFile}:${sourceKey}`;
    if (env.resolveCache.has(cacheKey)) {
      return env.resolveCache.get(cacheKey) ?? void 0;
    }
    if (!ctx.resolve) return void 0;
    try {
      const resolved = await ctx.resolve(sourceKey, importerId, {
        skipSelf: true
      });
      if (!resolved || resolved.external) return void 0;
      return resolved.id;
    } catch {
      return void 0;
    }
  }
  async function recordMockExportsForImporter(env, importerId, namesBySource, resolveSource) {
    const importerFile = normalizeFilePath(importerId);
    if (namesBySource.size === 0) return;
    for (const [source, names] of namesBySource) {
      try {
        const resolvedId = await resolveSource(source);
        if (!resolvedId) continue;
        namesBySource.set(normalizeFilePath(resolvedId), names);
        namesBySource.set(resolveExtensionlessAbsoluteId(resolvedId), names);
      } catch {
      }
    }
    const existing = env.mockExportsByImporter.get(importerFile);
    if (!existing) {
      env.mockExportsByImporter.set(importerFile, namesBySource);
      return;
    }
    for (const [source, names] of namesBySource) {
      const prev = existing.get(source);
      if (!prev) {
        existing.set(source, names);
        continue;
      }
      const union = /* @__PURE__ */ new Set([...prev, ...names]);
      existing.set(source, Array.from(union).sort());
    }
  }
  const shouldCheckImporterCache = /* @__PURE__ */ new Map();
  function shouldCheckImporter(importer) {
    let result = shouldCheckImporterCache.get(importer);
    if (result !== void 0) return result;
    const relativePath = relativizePath(importer, config.root);
    const excluded = config.excludeMatchers.length > 0 && matchesAny(relativePath, config.excludeMatchers) || config.ignoreImporterMatchers.length > 0 && matchesAny(relativePath, config.ignoreImporterMatchers);
    if (excluded) {
      result = false;
    } else if (config.includeMatchers.length > 0) {
      result = !!matchesAny(relativePath, config.includeMatchers);
    } else if (config.srcDirectory) {
      result = isInsideDirectory(importer, config.srcDirectory);
    } else {
      result = true;
    }
    shouldCheckImporterCache.set(importer, result);
    return result;
  }
  function dedupeKey(info) {
    return `${info.type}:${info.importer}:${info.specifier}:${info.resolved ?? ""}`;
  }
  function hasSeen(env, key) {
    if (config.logMode === "always") return false;
    if (env.seenViolations.has(key)) return true;
    env.seenViolations.add(key);
    return false;
  }
  function getRelativePath(absolutePath) {
    return relativizePath(normalizePath(absolutePath), config.root);
  }
  function clearEnvState(envState) {
    envState.resolveCache.clear();
    envState.resolveCacheByFile.clear();
    envState.importLocCache.clear();
    envState.seenViolations.clear();
    envState.transformResultCache.clear();
    envState.transformResultKeysByFile.clear();
    envState.postTransformImports.clear();
    envState.serverFnLookupModules.clear();
    envState.pendingViolations.clear();
    envState.deferredBuildViolations.length = 0;
    envState.graph.clear();
    envState.mockExportsByImporter.clear();
  }
  function invalidateFileFromEnv(envState, file) {
    envState.importLocCache.deleteByFile(file);
    const resolveKeys = envState.resolveCacheByFile.get(file);
    if (resolveKeys) {
      for (const key of resolveKeys) envState.resolveCache.delete(key);
      envState.resolveCacheByFile.delete(file);
    }
    envState.graph.invalidate(file);
    envState.mockExportsByImporter.delete(file);
    envState.serverFnLookupModules.delete(file);
    envState.pendingViolations.delete(file);
    const transformKeys = envState.transformResultKeysByFile.get(file);
    if (transformKeys) {
      for (const key of transformKeys) {
        envState.transformResultCache.delete(key);
        envState.postTransformImports.delete(key);
      }
      envState.transformResultKeysByFile.delete(file);
    } else {
      envState.transformResultCache.delete(file);
      envState.postTransformImports.delete(file);
    }
  }
  function cacheTransformResult(envState, file, cacheKey, result) {
    envState.transformResultCache.set(cacheKey, result);
    const keySet = getOrCreate(
      envState.transformResultKeysByFile,
      file,
      () => /* @__PURE__ */ new Set()
    );
    keySet.add(cacheKey);
    if (cacheKey !== file) {
      envState.transformResultCache.set(file, result);
      keySet.add(file);
    }
  }
  function registerEntries() {
    const { resolvedStartConfig } = opts.getConfig();
    for (const envDef of opts.environments) {
      const envState = getEnv(envDef.name);
      if (resolvedStartConfig.routerFilePath) {
        envState.graph.addEntry(
          normalizePath(resolvedStartConfig.routerFilePath)
        );
      }
      if (resolvedStartConfig.startFilePath) {
        envState.graph.addEntry(
          normalizePath(resolvedStartConfig.startFilePath)
        );
      }
    }
  }
  function getPostTransformImports(env, file) {
    const keySet = env.transformResultKeysByFile.get(file);
    let merged = null;
    if (keySet) {
      for (const k of keySet) {
        if (k.includes(SERVER_FN_LOOKUP_QUERY)) continue;
        const imports = env.postTransformImports.get(k);
        if (imports) {
          if (!merged) merged = new Set(imports);
          else for (const v of imports) merged.add(v);
        }
      }
    }
    if (!merged) {
      const imports = env.postTransformImports.get(file);
      if (imports) merged = new Set(imports);
    }
    return merged;
  }
  function checkEdgeLiveness(env, parent, target) {
    const keySet = env.transformResultKeysByFile.get(parent);
    let anyVariantCached = false;
    if (keySet) {
      for (const k of keySet) {
        if (k.includes(SERVER_FN_LOOKUP_QUERY)) continue;
        const imports = env.postTransformImports.get(k);
        if (imports) {
          anyVariantCached = true;
          if (imports.has(target)) return "live";
        }
      }
    }
    if (!anyVariantCached) {
      const imports = env.postTransformImports.get(parent);
      if (imports) return imports.has(target) ? "live" : "dead";
      const hasTransformResult = env.transformResultCache.has(parent) || (keySet ? keySet.size > 0 : false);
      return hasTransformResult ? "pending" : "no-data";
    }
    return "dead";
  }
  function checkPostTransformReachability(env, file) {
    const visited = /* @__PURE__ */ new Set();
    const queue = [file];
    let hasUnknownEdge = false;
    let qi = 0;
    while (qi < queue.length) {
      const current = queue[qi++];
      if (visited.has(current)) continue;
      visited.add(current);
      if (env.graph.entries.has(current)) {
        return "reachable";
      }
      const importers = env.graph.reverseEdges.get(current);
      if (!importers) continue;
      for (const [parent] of importers) {
        if (visited.has(parent)) continue;
        const liveness = checkEdgeLiveness(env, parent, current);
        if (liveness === "live" || liveness === "no-data") {
          queue.push(parent);
        } else if (liveness === "pending") {
          hasUnknownEdge = true;
        }
      }
    }
    return hasUnknownEdge ? "unknown" : "unreachable";
  }
  function filterEdgeSurvival(env, file, violations) {
    const postTransform = getPostTransformImports(env, file);
    if (postTransform) {
      const surviving = violations.filter(
        (pv) => !pv.info.resolved || postTransform.has(pv.info.resolved)
      );
      if (surviving.length === 0) return "all-stripped";
      env.pendingViolations.set(file, surviving);
      return { active: surviving, edgeSurvivalApplied: true };
    }
    if (violations.some((pv) => pv.fromPreTransformResolve)) {
      return "await-transform";
    }
    return { active: violations, edgeSurvivalApplied: false };
  }
  async function processPendingViolations(env, warnFn) {
    if (env.pendingViolations.size === 0) return;
    const toDelete = [];
    for (const [file, violations] of env.pendingViolations) {
      const filtered = filterEdgeSurvival(env, file, violations);
      if (filtered === "all-stripped") {
        toDelete.push(file);
        continue;
      }
      if (filtered === "await-transform") continue;
      const { active, edgeSurvivalApplied } = filtered;
      const status = env.graph.entries.size > 0 ? checkPostTransformReachability(env, file) : "unknown";
      if (status === "reachable") {
        for (const pv of active) {
          await emitPendingViolation(env, warnFn, pv);
        }
        toDelete.push(file);
      } else if (status === "unreachable") {
        toDelete.push(file);
      } else if (config.command === "serve") {
        let emittedAny = false;
        for (const pv of active) {
          if (pv.fromPreTransformResolve) continue;
          const shouldEmit = edgeSurvivalApplied || pv.info.type === "file" && !!pv.info.resolved && isInsideDirectory(pv.info.resolved, config.srcDirectory);
          if (shouldEmit) {
            emittedAny = await emitPendingViolation(env, warnFn, pv) || emittedAny;
          }
        }
        if (emittedAny) {
          toDelete.push(file);
        }
      }
    }
    for (const file of toDelete) {
      env.pendingViolations.delete(file);
    }
  }
  async function emitPendingViolation(env, warnFn, pv) {
    if (!pv.info.importerLoc) {
      const sourceCandidates = buildSourceCandidates(
        pv.info.specifier,
        pv.info.resolved,
        config.root
      );
      const loc = await resolveImporterLocation(
        env.transformResultProvider,
        env,
        pv.info.importer,
        sourceCandidates
      );
      if (loc) {
        pv.info.importerLoc = loc;
        pv.info.snippet = buildCodeSnippet(
          env.transformResultProvider,
          pv.info.importer,
          loc
        );
      }
    }
    if (hasSeen(env, dedupeKey(pv.info))) {
      return false;
    }
    const freshTrace = await rebuildAndAnnotateTrace(
      env.transformResultProvider,
      env,
      pv.info.env,
      pv.info.importer,
      pv.info.specifier,
      pv.info.importerLoc
    );
    if (freshTrace.length > pv.info.trace.length) {
      pv.info.trace = freshTrace;
    }
    if (config.onViolation) {
      const result = await config.onViolation(pv.info);
      if (result === false) return false;
    }
    warnFn(formatViolation(pv.info, config.root));
    return true;
  }
  function deferViolation(env, importerFile, info, isPreTransformResolve) {
    getOrCreate(env.pendingViolations, importerFile, () => []).push({
      info,
      fromPreTransformResolve: isPreTransformResolve
    });
  }
  let buildViolationCounter = 0;
  async function handleViolation(ctx, env, info, importerIdHint, violationOpts) {
    if (!violationOpts?.silent) {
      if (config.onViolation) {
        const result = await config.onViolation(info);
        if (result === false) return void 0;
      }
      if (config.effectiveBehavior === "error") {
        return ctx.error(formatViolation(info, config.root));
      }
      if (!hasSeen(env, dedupeKey(info))) {
        ctx.warn(formatViolation(info, config.root));
      }
    } else if (config.effectiveBehavior === "error" && config.command !== "build") {
      return void 0;
    }
    if (info.type === "file") return info.resolved;
    const exports = await resolveExportsForDeniedSpecifier(
      env,
      ctx,
      info,
      importerIdHint
    );
    const baseMockId = config.command === "serve" ? mockRuntimeModuleIdFromViolation(info, config.mockAccess, config.root) : `${MOCK_BUILD_PREFIX}${buildViolationCounter++}`;
    return resolveViteId(makeMockEdgeModuleId(exports, baseMockId));
  }
  async function reportOrDeferViolation(ctx, env, importerFile, importerIdHint, info, shouldDefer, isPreTransformResolve) {
    if (shouldDefer) {
      const result = await handleViolation(ctx, env, info, importerIdHint, {
        silent: true
      });
      if (config.command === "build") {
        const mockId = result ?? "";
        env.deferredBuildViolations.push({
          info,
          mockModuleId: mockId,
          // For marker violations, check importer survival instead of mock.
          checkModuleId: info.type === "marker" ? info.importer : void 0
        });
      } else {
        deferViolation(env, importerFile, info, isPreTransformResolve);
        await processPendingViolations(env, ctx.warn.bind(ctx));
      }
      return result;
    }
    return handleViolation(ctx, env, info, importerIdHint, {
      silent: isPreTransformResolve
    });
  }
  return [
    {
      name: "tanstack-start-core:import-protection",
      enforce: "pre",
      applyToEnvironment(env) {
        if (!config.enabled) return false;
        return environmentNames.has(env.name);
      },
      configResolved(viteConfig) {
        config.root = viteConfig.root;
        config.command = viteConfig.command;
        const { startConfig, resolvedStartConfig } = opts.getConfig();
        config.srcDirectory = resolvedStartConfig.srcDirectory;
        const userOpts = startConfig.importProtection;
        if (userOpts?.enabled === false) {
          config.enabled = false;
          return;
        }
        config.enabled = true;
        const behavior = userOpts?.behavior;
        if (typeof behavior === "string") {
          config.effectiveBehavior = behavior;
        } else {
          config.effectiveBehavior = viteConfig.command === "serve" ? behavior?.dev ?? "mock" : behavior?.build ?? "error";
        }
        config.logMode = userOpts?.log ?? "once";
        config.mockAccess = userOpts?.mockAccess ?? "error";
        config.maxTraceDepth = userOpts?.maxTraceDepth ?? 20;
        if (userOpts?.onViolation) {
          const fn = userOpts.onViolation;
          config.onViolation = (info) => fn(info);
        }
        const defaults = getDefaultImportProtectionRules();
        const pick = (user, fallback) => user ? [...user] : [...fallback];
        const clientSpecifiers = dedupePatterns([
          ...defaults.client.specifiers,
          ...userOpts?.client?.specifiers ?? []
        ]);
        config.compiledRules.client = {
          specifiers: compileMatchers(clientSpecifiers),
          files: compileMatchers(
            pick(userOpts?.client?.files, defaults.client.files)
          ),
          excludeFiles: compileMatchers(
            pick(userOpts?.client?.excludeFiles, defaults.client.excludeFiles)
          )
        };
        config.compiledRules.server = {
          specifiers: compileMatchers(
            dedupePatterns(
              pick(userOpts?.server?.specifiers, defaults.server.specifiers)
            )
          ),
          files: compileMatchers(
            pick(userOpts?.server?.files, defaults.server.files)
          ),
          excludeFiles: compileMatchers(
            pick(userOpts?.server?.excludeFiles, defaults.server.excludeFiles)
          )
        };
        config.includeMatchers = compileMatchers(userOpts?.include ?? []);
        config.excludeMatchers = compileMatchers(userOpts?.exclude ?? []);
        config.ignoreImporterMatchers = compileMatchers(
          userOpts?.ignoreImporters ?? []
        );
        const markers = getMarkerSpecifiers();
        config.markerSpecifiers = {
          serverOnly: new Set(markers.serverOnly),
          clientOnly: new Set(markers.clientOnly)
        };
      },
      configureServer(server) {
        devServer = server;
      },
      buildStart() {
        if (!config.enabled) return;
        clearNormalizeFilePathCache();
        extensionlessIdResolver.clear();
        importPatternCache.clear();
        shouldCheckImporterCache.clear();
        for (const envState of envStates.values()) {
          clearEnvState(envState);
        }
        shared.fileMarkerKind.clear();
        registerEntries();
      },
      hotUpdate(ctx) {
        if (!config.enabled) return;
        for (const mod of ctx.modules) {
          if (mod.id) {
            const id = mod.id;
            const importerFile = normalizeFilePath(id);
            extensionlessIdResolver.invalidateByFile(importerFile);
            shared.fileMarkerKind.delete(importerFile);
            for (const envState of envStates.values()) {
              invalidateFileFromEnv(envState, importerFile);
            }
          }
        }
      },
      async resolveId(source, importer, _options) {
        const envName = this.environment.name;
        const env = getEnv(envName);
        const envType = getEnvType(envName);
        const provider = env.transformResultProvider;
        const isScanResolve = !!_options.scan;
        if (IMPORT_PROTECTION_DEBUG) {
          const importerPath = importer ? normalizeFilePath(importer) : "(entry)";
          const isEntryResolve = !importer;
          const filtered = process.env.TSR_IMPORT_PROTECTION_DEBUG_FILTER === "entry" ? isEntryResolve : matchesDebugFilter(source, importerPath);
          if (filtered) {
            debugLog("resolveId", {
              env: envName,
              envType,
              source,
              importer: importerPath,
              isEntryResolve,
              command: config.command
            });
          }
        }
        const internalVirtualId = resolveInternalVirtualModuleId(source);
        if (internalVirtualId) return internalVirtualId;
        if (!importer) {
          env.graph.addEntry(source);
          await processPendingViolations(env, this.warn.bind(this));
          return void 0;
        }
        if (source.startsWith("\0") || source.startsWith("virtual:")) {
          return void 0;
        }
        const normalizedImporter = normalizeFilePath(importer);
        const isDirectLookup = importer.includes(SERVER_FN_LOOKUP_QUERY);
        if (isDirectLookup) {
          env.serverFnLookupModules.add(normalizedImporter);
        }
        const isPreTransformResolve = isDirectLookup || env.serverFnLookupModules.has(normalizedImporter) || isScanResolve;
        const isDevMock = config.command === "serve" && config.effectiveBehavior === "mock";
        const isBuild = config.command === "build";
        const shouldDefer = shouldDeferViolation({ isBuild, isDevMock });
        const resolveAgainstImporter = async () => {
          const primary = await this.resolve(source, importer, {
            skipSelf: true
          });
          if (primary) {
            return canonicalizeResolvedId(
              primary.id,
              config.root,
              resolveExtensionlessAbsoluteId
            );
          }
          return null;
        };
        const markerKind = config.markerSpecifiers.serverOnly.has(source) ? "server" : config.markerSpecifiers.clientOnly.has(source) ? "client" : void 0;
        if (markerKind) {
          const existing = shared.fileMarkerKind.get(normalizedImporter);
          if (existing && existing !== markerKind) {
            this.error(
              `[import-protection] File "${getRelativePath(normalizedImporter)}" has both server-only and client-only markers. This is not allowed.`
            );
          }
          shared.fileMarkerKind.set(normalizedImporter, markerKind);
          const violatesEnv = envType === "client" && markerKind === "server" || envType === "server" && markerKind === "client";
          if (violatesEnv) {
            const info = await buildViolationInfo(
              provider,
              env,
              envName,
              envType,
              importer,
              normalizedImporter,
              source,
              {
                type: "marker",
                message: buildMarkerViolationMessage(
                  getRelativePath(normalizedImporter),
                  markerKind
                )
              }
            );
            const markerResult = await reportOrDeferViolation(
              this,
              env,
              normalizedImporter,
              importer,
              info,
              shouldDefer,
              isPreTransformResolve
            );
            if (isBuild && markerResult != null) {
              return markerResult;
            }
          }
          const envRetroKey = `retro-marker:${normalizedImporter}`;
          if (violatesEnv && !env.seenViolations.has(envRetroKey)) {
            env.seenViolations.add(envRetroKey);
            let retroDeferred = false;
            const importersMap = env.graph.reverseEdges.get(normalizedImporter);
            if (importersMap && importersMap.size > 0) {
              for (const [importerFile, specifier] of importersMap) {
                if (!specifier) continue;
                if (!shouldCheckImporter(importerFile)) continue;
                const markerInfo = await buildMarkerViolationFromResolvedImport(
                  provider,
                  env,
                  envName,
                  envType,
                  importerFile,
                  specifier,
                  normalizedImporter,
                  getRelativePath(normalizedImporter)
                );
                if (markerInfo) {
                  deferViolation(
                    env,
                    importerFile,
                    markerInfo,
                    isPreTransformResolve
                  );
                  retroDeferred = true;
                }
              }
            }
            if (retroDeferred) {
              await processPendingViolations(env, this.warn.bind(this));
            }
          }
          return markerKind === "server" ? resolvedMarkerVirtualModuleId("server") : resolvedMarkerVirtualModuleId("client");
        }
        if (!shouldCheckImporter(normalizedImporter)) {
          return void 0;
        }
        const matchers = getRulesForEnvironment(envName);
        const specifierMatch = matchesAny(source, matchers.specifiers);
        if (specifierMatch) {
          if (!isPreTransformResolve) {
            env.graph.addEdge(source, normalizedImporter, source);
          }
          const info = await buildViolationInfo(
            provider,
            env,
            envName,
            envType,
            importer,
            normalizedImporter,
            source,
            {
              type: "specifier",
              pattern: specifierMatch.pattern,
              message: `Import "${source}" is denied in the ${envType} environment`
            }
          );
          if (shouldDefer && !info.resolved) {
            try {
              const resolvedForInfo = await resolveAgainstImporter();
              if (resolvedForInfo) info.resolved = resolvedForInfo;
            } catch {
            }
          }
          return reportOrDeferViolation(
            this,
            env,
            normalizedImporter,
            importer,
            info,
            shouldDefer,
            isPreTransformResolve
          );
        }
        const cacheKey = `${normalizedImporter}:${source}`;
        let resolved;
        if (env.resolveCache.has(cacheKey)) {
          resolved = env.resolveCache.get(cacheKey) ?? null;
        } else {
          resolved = await resolveAgainstImporter();
          if (resolved !== null) {
            env.resolveCache.set(cacheKey, resolved);
            getOrCreate(
              env.resolveCacheByFile,
              normalizedImporter,
              () => /* @__PURE__ */ new Set()
            ).add(cacheKey);
          }
        }
        if (resolved) {
          const relativePath = getRelativePath(resolved);
          if (isPreTransformResolve && !isScanResolve) {
            env.serverFnLookupModules.add(resolved);
          }
          if (!isPreTransformResolve) {
            env.graph.addEdge(resolved, normalizedImporter, source);
          }
          const isExcludedFile = matchers.excludeFiles.length > 0 && matchesAny(relativePath, matchers.excludeFiles);
          if (!isExcludedFile) {
            const fileMatch = matchers.files.length > 0 ? matchesAny(relativePath, matchers.files) : void 0;
            if (fileMatch) {
              const info = await buildFileViolationInfo(
                provider,
                env,
                envName,
                envType,
                importer,
                normalizedImporter,
                source,
                resolved,
                fileMatch.pattern
              );
              return reportOrDeferViolation(
                this,
                env,
                normalizedImporter,
                importer,
                info,
                shouldDefer,
                isPreTransformResolve
              );
            }
            const markerInfo = await buildMarkerViolationFromResolvedImport(
              provider,
              env,
              envName,
              envType,
              importer,
              source,
              resolved,
              relativePath
            );
            if (markerInfo) {
              return reportOrDeferViolation(
                this,
                env,
                normalizedImporter,
                importer,
                markerInfo,
                shouldDefer,
                isPreTransformResolve
              );
            }
          }
        }
        return void 0;
      },
      load: {
        filter: {
          id: new RegExp(
            getResolvedVirtualModuleMatchers().map(escapeRegExp).join("|")
          )
        },
        handler(id) {
          if (IMPORT_PROTECTION_DEBUG) {
            if (matchesDebugFilter(id)) {
              debugLog("load:handler", {
                env: this.environment.name,
                id: normalizePath(id)
              });
            }
          }
          return loadResolvedVirtualModule(id);
        }
      },
      async generateBundle(_options, bundle) {
        const envName = this.environment.name;
        const env = envStates.get(envName);
        if (!env || env.deferredBuildViolations.length === 0) return;
        const candidateCache = /* @__PURE__ */ new Map();
        const toModuleIdCandidates = (id) => {
          let cached = candidateCache.get(id);
          if (cached) return cached;
          const out = /* @__PURE__ */ new Set();
          const normalized = normalizeFilePath(id);
          out.add(id);
          out.add(normalized);
          out.add(relativizePath(normalized, config.root));
          if (normalized.startsWith(VITE_BROWSER_VIRTUAL_PREFIX)) {
            const internal = `\0${normalized.slice(VITE_BROWSER_VIRTUAL_PREFIX.length)}`;
            out.add(internal);
            out.add(relativizePath(normalizeFilePath(internal), config.root));
          }
          if (normalized.startsWith("\0")) {
            const browser = `${VITE_BROWSER_VIRTUAL_PREFIX}${normalized.slice(1)}`;
            out.add(browser);
            out.add(relativizePath(normalizeFilePath(browser), config.root));
          }
          cached = Array.from(out);
          candidateCache.set(id, cached);
          return cached;
        };
        const survivingModules = /* @__PURE__ */ new Set();
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === "chunk") {
            for (const moduleId of Object.keys(chunk.modules)) {
              for (const candidate of toModuleIdCandidates(moduleId)) {
                survivingModules.add(candidate);
              }
            }
          }
        }
        const didModuleSurvive = (moduleId) => toModuleIdCandidates(moduleId).some(
          (candidate) => survivingModules.has(candidate)
        );
        const realViolations = [];
        for (const {
          info,
          mockModuleId,
          checkModuleId
        } of env.deferredBuildViolations) {
          let survived;
          if (checkModuleId != null) {
            const importerVariantIds = /* @__PURE__ */ new Set([info.importer]);
            const importerKeys = env.transformResultKeysByFile.get(
              normalizeFilePath(info.importer)
            );
            if (importerKeys) {
              for (const key of importerKeys) {
                importerVariantIds.add(key);
              }
            }
            survived = false;
            for (const importerId of importerVariantIds) {
              if (didModuleSurvive(importerId)) {
                survived = true;
                break;
              }
            }
          } else {
            survived = didModuleSurvive(mockModuleId);
          }
          if (!survived) continue;
          if (config.onViolation) {
            const result = await config.onViolation(info);
            if (result === false) continue;
          }
          realViolations.push(info);
        }
        if (realViolations.length === 0) return;
        if (config.effectiveBehavior === "error") {
          this.error(formatViolation(realViolations[0], config.root));
        } else {
          const seen = /* @__PURE__ */ new Set();
          for (const info of realViolations) {
            const key = dedupeKey(info);
            if (!seen.has(key)) {
              seen.add(key);
              this.warn(formatViolation(info, config.root));
            }
          }
        }
      }
    },
    {
      // Captures transformed code + composed sourcemap for location mapping.
      // Runs after all `enforce: 'pre'` hooks (including the Start compiler).
      // Only files under `srcDirectory` are cached.
      name: "tanstack-start-core:import-protection-transform-cache",
      applyToEnvironment(env) {
        if (!config.enabled) return false;
        return environmentNames.has(env.name);
      },
      transform: {
        filter: {
          id: {
            include: [/\.[cm]?[tj]sx?($|\?)/]
          }
        },
        async handler(code, id) {
          const envName = this.environment.name;
          const file = normalizeFilePath(id);
          const envType = getEnvType(envName);
          const matchers = getRulesForEnvironment(envName);
          const isBuild = config.command === "build";
          if (IMPORT_PROTECTION_DEBUG) {
            if (matchesDebugFilter(file)) {
              debugLog("transform-cache", {
                env: envName,
                id: normalizePath(id),
                file
              });
            }
          }
          if (!shouldCheckImporter(file)) {
            return void 0;
          }
          const selfFileMatch = checkFileDenial(getRelativePath(file), matchers);
          if (selfFileMatch) {
            let exportNames = [];
            try {
              exportNames = collectNamedExports(code);
            } catch {
            }
            if (isBuild) {
              return generateSelfContainedMockModule(exportNames);
            }
            const runtimeId = mockRuntimeModuleIdFromViolation(
              {
                env: envType,
                behavior: config.effectiveBehavior === "error" ? "error" : "mock",
                importer: file,
                specifier: relativizePath(file, config.root),
                pattern: selfFileMatch.pattern,
                message: `File "${relativizePath(file, config.root)}" is denied in the ${envType} environment`,
                trace: []
              },
              config.mockAccess,
              config.root
            );
            return generateDevSelfDenialModule(exportNames, runtimeId);
          }
          let map;
          try {
            map = this.getCombinedSourcemap();
          } catch {
            map = void 0;
          }
          let originalCode;
          if (map?.sourcesContent) {
            originalCode = pickOriginalCodeFromSourcesContent(
              map,
              file,
              config.root
            );
          }
          const lineIndex = buildLineIndex(code);
          const cacheKey = normalizePath(id);
          const envState = getEnv(envName);
          const isServerFnLookup = id.includes(SERVER_FN_LOOKUP_QUERY);
          if (isServerFnLookup) {
            envState.serverFnLookupModules.add(file);
          }
          const result = {
            code,
            map,
            originalCode,
            lineIndex
          };
          cacheTransformResult(envState, file, cacheKey, result);
          if (isBuild) return void 0;
          const isDevMock = config.effectiveBehavior === "mock";
          const importSources = extractImportSources(code);
          const resolvedChildren = /* @__PURE__ */ new Set();
          const deniedSourceReplacements = /* @__PURE__ */ new Map();
          for (const src of importSources) {
            try {
              const resolved = await this.resolve(src, id, { skipSelf: true });
              if (resolved && !resolved.external) {
                const resolvedPath = canonicalizeResolvedId(
                  resolved.id,
                  config.root,
                  resolveExtensionlessAbsoluteId
                );
                resolvedChildren.add(resolvedPath);
                if (resolved.id.includes("tanstack-start-import-protection:")) {
                  let physicalPath;
                  const pending = envState.pendingViolations.get(file);
                  if (pending) {
                    const match = pending.find(
                      (pv) => pv.info.specifier === src && pv.info.resolved
                    );
                    if (match) physicalPath = match.info.resolved;
                  }
                  if (physicalPath && physicalPath !== resolvedPath) {
                    resolvedChildren.add(physicalPath);
                    envState.graph.addEdge(physicalPath, file, src);
                  }
                }
                envState.graph.addEdge(resolvedPath, file, src);
                if (isDevMock) {
                  const relativePath = getRelativePath(resolvedPath);
                  const fileMatch = checkFileDenial(relativePath, matchers);
                  if (fileMatch) {
                    const info = await buildFileViolationInfo(
                      envState.transformResultProvider,
                      envState,
                      envName,
                      envType,
                      id,
                      file,
                      src,
                      resolvedPath,
                      fileMatch.pattern
                    );
                    const replacement = await reportOrDeferViolation(
                      this,
                      envState,
                      file,
                      id,
                      info,
                      isDevMock,
                      isServerFnLookup
                    );
                    if (replacement) {
                      deniedSourceReplacements.set(
                        src,
                        replacement.startsWith("\0") ? VITE_BROWSER_VIRTUAL_PREFIX + replacement.slice(1) : replacement
                      );
                    }
                  }
                }
              }
            } catch {
            }
          }
          envState.postTransformImports.set(cacheKey, resolvedChildren);
          if (cacheKey !== file && !isServerFnLookup) {
            envState.postTransformImports.set(file, resolvedChildren);
          }
          await processPendingViolations(envState, this.warn.bind(this));
          if (deniedSourceReplacements.size > 0) {
            try {
              const rewritten = rewriteDeniedImports(
                code,
                id,
                new Set(deniedSourceReplacements.keys()),
                (source) => deniedSourceReplacements.get(source) ?? source
              );
              if (!rewritten) {
                return void 0;
              }
              const normalizedMap = rewritten.map ? {
                ...rewritten.map,
                version: Number(rewritten.map.version),
                sourcesContent: rewritten.map.sourcesContent?.map(
                  (s) => s ?? ""
                ) ?? []
              } : {
                version: 3,
                file: id,
                names: [],
                sources: [id],
                sourcesContent: [code],
                mappings: ""
              };
              return {
                code: rewritten.code,
                map: normalizedMap
              };
            } catch {
            }
          }
          return void 0;
        }
      }
    }
  ];
}
export {
  importProtectionPlugin
};
//# sourceMappingURL=plugin.js.map
