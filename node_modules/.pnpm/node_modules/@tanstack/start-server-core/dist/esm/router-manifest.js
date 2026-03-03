import { rootRouteId, buildDevStylesUrl } from "@tanstack/router-core";
const DEV_SSR_STYLES_BASEPATH = process.env.TSS_DEV_SSR_STYLES_BASEPATH || "/";
async function getStartManifest(matchedRoutes) {
  const { tsrStartManifest } = await import("tanstack-start-manifest:v");
  const startManifest = tsrStartManifest();
  const rootRoute = startManifest.routes[rootRouteId] = startManifest.routes[rootRouteId] || {};
  rootRoute.assets = rootRoute.assets || [];
  if (process.env.TSS_DEV_SERVER === "true" && process.env.TSS_DEV_SSR_STYLES_ENABLED !== "false" && matchedRoutes) {
    const matchedRouteIds = matchedRoutes.map((route) => route.id);
    rootRoute.assets.push({
      tag: "link",
      attrs: {
        rel: "stylesheet",
        href: buildDevStylesUrl(DEV_SSR_STYLES_BASEPATH, matchedRouteIds),
        "data-tanstack-router-dev-styles": "true"
      }
    });
  }
  let injectedHeadScripts;
  if (process.env.TSS_DEV_SERVER === "true") {
    const mod = await import("tanstack-start-injected-head-scripts:v");
    if (mod.injectedHeadScripts) {
      injectedHeadScripts = mod.injectedHeadScripts;
    }
  }
  const manifest = {
    routes: Object.fromEntries(
      Object.entries(startManifest.routes).flatMap(([k, v]) => {
        const result = {};
        let hasData = false;
        if (v.preloads && v.preloads.length > 0) {
          result["preloads"] = v.preloads;
          hasData = true;
        }
        if (v.assets && v.assets.length > 0) {
          result["assets"] = v.assets;
          hasData = true;
        }
        if (!hasData) {
          return [];
        }
        return [[k, result]];
      })
    )
  };
  return {
    manifest,
    clientEntry: startManifest.clientEntry,
    injectedHeadScripts
  };
}
export {
  getStartManifest
};
//# sourceMappingURL=router-manifest.js.map
