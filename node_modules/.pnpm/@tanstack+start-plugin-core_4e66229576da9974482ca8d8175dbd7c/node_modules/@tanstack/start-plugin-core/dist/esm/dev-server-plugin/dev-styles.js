import path from "node:path";
const CSS_FILE_REGEX = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
const CSS_MODULES_REGEX = /\.module\.(css|less|sass|scss|styl|stylus)(?:$|[?#])/i;
function normalizeCssModuleCacheKey(idOrFile) {
  const baseId = idOrFile.split("?")[0].split("#")[0];
  return baseId.replace(/\\/g, "/");
}
const CSS_SIDE_EFFECT_FREE_PARAMS = ["url", "inline", "raw", "inline-css"];
const VITE_CSS_MARKER = "const __vite__css = ";
const ESCAPE_CSS_COMMENT_START_REGEX = /\/\*/g;
const ESCAPE_CSS_COMMENT_END_REGEX = /\*\//g;
function isCssFile(file) {
  return CSS_FILE_REGEX.test(file);
}
function isCssModulesFile(file) {
  return CSS_MODULES_REGEX.test(file);
}
function hasCssSideEffectFreeParam(url) {
  const queryString = url.split("?")[1];
  if (!queryString) return false;
  const params = new URLSearchParams(queryString);
  return CSS_SIDE_EFFECT_FREE_PARAMS.some(
    (param) => params.get(param) === "" && !url.includes(`?${param}=`) && !url.includes(`&${param}=`)
  );
}
function resolveDevUrl(rootDirectory, filePath) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const relativePath = path.posix.relative(
    rootDirectory.replace(/\\/g, "/"),
    normalizedPath
  );
  const isWithinRoot = !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  if (isWithinRoot) {
    return path.posix.join("/", relativePath);
  }
  return path.posix.join("/@fs", normalizedPath);
}
async function collectDevStyles(opts) {
  const { viteDevServer, entries, cssModulesCache = {} } = opts;
  const styles = /* @__PURE__ */ new Map();
  const visited = /* @__PURE__ */ new Set();
  const rootDirectory = viteDevServer.config.root;
  await Promise.all(
    entries.map(
      (entry) => processEntry(viteDevServer, resolveDevUrl(rootDirectory, entry), visited)
    )
  );
  const cssPromises = [];
  for (const dep of visited) {
    if (hasCssSideEffectFreeParam(dep.url)) {
      continue;
    }
    if (dep.file && isCssModulesFile(dep.file)) {
      const css = cssModulesCache[normalizeCssModuleCacheKey(dep.file)];
      if (!css) {
        continue;
      }
      styles.set(dep.url, css);
      continue;
    }
    const fileOrUrl = dep.file ?? dep.url;
    if (!isCssFile(fileOrUrl)) {
      continue;
    }
    cssPromises.push(
      fetchCssFromModule(viteDevServer, dep).then(
        (css) => css ? [dep.url, css] : null
      )
    );
  }
  const cssResults = await Promise.all(cssPromises);
  for (const result of cssResults) {
    if (result) {
      styles.set(result[0], result[1]);
    }
  }
  if (styles.size === 0) return void 0;
  const parts = [];
  for (const [fileName, css] of styles.entries()) {
    const escapedFileName = fileName.replace(ESCAPE_CSS_COMMENT_START_REGEX, "/\\*").replace(ESCAPE_CSS_COMMENT_END_REGEX, "*\\/");
    parts.push(`
/* ${escapedFileName} */
${css}`);
  }
  return parts.join("\n");
}
async function processEntry(viteDevServer, entryUrl, visited) {
  let node = await viteDevServer.moduleGraph.getModuleByUrl(entryUrl);
  if (!node?.ssrTransformResult) {
    try {
      await viteDevServer.transformRequest(entryUrl);
    } catch {
    }
    node = await viteDevServer.moduleGraph.getModuleByUrl(entryUrl);
  }
  if (!node || visited.has(node)) return;
  visited.add(node);
  await findModuleDeps(viteDevServer, node, visited);
}
async function findModuleDeps(viteDevServer, node, visited) {
  const deps = node.ssrTransformResult?.deps ?? node.transformResult?.deps ?? null;
  const importedModules = node.importedModules;
  if ((!deps || deps.length === 0) && importedModules.size === 0) {
    return;
  }
  const branches = [];
  if (deps) {
    for (const depUrl of deps) {
      const dep = await viteDevServer.moduleGraph.getModuleByUrl(depUrl);
      if (!dep) continue;
      if (visited.has(dep)) continue;
      visited.add(dep);
      branches.push(findModuleDeps(viteDevServer, dep, visited));
    }
  }
  for (const depNode of importedModules) {
    if (visited.has(depNode)) continue;
    visited.add(depNode);
    branches.push(findModuleDeps(viteDevServer, depNode, visited));
  }
  if (branches.length === 1) {
    await branches[0];
    return;
  }
  await Promise.all(branches);
}
async function fetchCssFromModule(viteDevServer, node) {
  const cachedCode = node.transformResult?.code ?? node.ssrTransformResult?.code;
  if (cachedCode) {
    return extractCssFromCode(cachedCode);
  }
  try {
    const transformResult = await viteDevServer.transformRequest(node.url);
    if (!transformResult?.code) return void 0;
    return extractCssFromCode(transformResult.code);
  } catch {
    return void 0;
  }
}
function extractCssFromCode(code) {
  const startIdx = code.indexOf(VITE_CSS_MARKER);
  if (startIdx === -1) return void 0;
  const valueStart = startIdx + VITE_CSS_MARKER.length;
  if (code.charCodeAt(valueStart) !== 34) return void 0;
  const codeLength = code.length;
  let i = valueStart + 1;
  while (i < codeLength) {
    const charCode = code.charCodeAt(i);
    if (charCode === 34) {
      try {
        return JSON.parse(code.slice(valueStart, i + 1));
      } catch {
        return void 0;
      }
    }
    if (charCode === 92) {
      i += 2;
    } else {
      i++;
    }
  }
  return void 0;
}
export {
  CSS_MODULES_REGEX,
  collectDevStyles,
  extractCssFromCode,
  isCssModulesFile,
  normalizeCssModuleCacheKey
};
//# sourceMappingURL=dev-styles.js.map
