import { rootRouteId } from "@tanstack/router-core";
function resolveTransformConfig(transform) {
  if (typeof transform === "string") {
    const prefix = transform;
    return {
      type: "transform",
      transformFn: ({ url }) => `${prefix}${url}`,
      cache: true
    };
  }
  if (typeof transform === "function") {
    return {
      type: "transform",
      transformFn: transform,
      cache: true
    };
  }
  if ("createTransform" in transform && transform.createTransform) {
    return {
      type: "createTransform",
      createTransform: transform.createTransform,
      cache: transform.cache !== false
    };
  }
  const transformFn = typeof transform.transform === "string" ? (({ url }) => `${transform.transform}${url}`) : transform.transform;
  return {
    type: "transform",
    transformFn,
    cache: transform.cache !== false
  };
}
function buildClientEntryScriptTag(clientEntry, injectedHeadScripts) {
  const clientEntryLiteral = JSON.stringify(clientEntry);
  let script = `import(${clientEntryLiteral})`;
  if (injectedHeadScripts) {
    script = `${injectedHeadScripts};${script}`;
  }
  return {
    tag: "script",
    attrs: {
      type: "module",
      async: true
    },
    children: script
  };
}
function transformManifestUrls(source, transformFn, opts) {
  return (async () => {
    const manifest = opts?.clone ? structuredClone(source.manifest) : source.manifest;
    for (const route of Object.values(manifest.routes)) {
      if (route.preloads) {
        route.preloads = await Promise.all(
          route.preloads.map(
            (url) => Promise.resolve(transformFn({ url, type: "modulepreload" }))
          )
        );
      }
      if (route.assets) {
        for (const asset of route.assets) {
          if (asset.tag === "link" && asset.attrs?.href) {
            asset.attrs.href = await Promise.resolve(
              transformFn({
                url: asset.attrs.href,
                type: "stylesheet"
              })
            );
          }
        }
      }
    }
    const transformedClientEntry = await Promise.resolve(
      transformFn({
        url: source.clientEntry,
        type: "clientEntry"
      })
    );
    const rootRoute = manifest.routes[rootRouteId];
    if (rootRoute) {
      rootRoute.assets = rootRoute.assets || [];
      rootRoute.assets.push(
        buildClientEntryScriptTag(
          transformedClientEntry,
          source.injectedHeadScripts
        )
      );
    }
    return manifest;
  })();
}
function buildManifestWithClientEntry(source) {
  const scriptTag = buildClientEntryScriptTag(
    source.clientEntry,
    source.injectedHeadScripts
  );
  const baseRootRoute = source.manifest.routes[rootRouteId];
  const routes = {
    ...source.manifest.routes,
    ...baseRootRoute ? {
      [rootRouteId]: {
        ...baseRootRoute,
        assets: [...baseRootRoute.assets || [], scriptTag]
      }
    } : {}
  };
  return { routes };
}
export {
  buildClientEntryScriptTag,
  buildManifestWithClientEntry,
  resolveTransformConfig,
  transformManifestUrls
};
//# sourceMappingURL=transformAssetUrls.js.map
