import { isRunnableDevEnvironment } from "vite";
import { VIRTUAL_MODULES } from "@tanstack/start-server-core";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import { VITE_ENVIRONMENT_NAMES, ENTRY_POINTS } from "../constants.js";
import { resolveViteId } from "../utils.js";
import { extractHtmlScripts } from "./extract-html-scripts.js";
import { CSS_MODULES_REGEX, collectDevStyles, normalizeCssModuleCacheKey } from "./dev-styles.js";
function devServerPlugin({
  getConfig,
  devSsrStylesEnabled
}) {
  let isTest = false;
  let injectedHeadScripts;
  const cssModulesCache = {};
  return [
    {
      name: "tanstack-start-core:dev-server",
      config(_userConfig, { mode }) {
        isTest = isTest ? isTest : mode === "test";
      },
      // Capture CSS modules content during transform
      transform: {
        filter: {
          id: CSS_MODULES_REGEX
        },
        handler(code, id) {
          cssModulesCache[normalizeCssModuleCacheKey(id)] = code;
        }
      },
      async configureServer(viteDevServer) {
        if (isTest) {
          return;
        }
        const templateHtml = `<html><head></head><body></body></html>`;
        const transformedHtml = await viteDevServer.transformIndexHtml(
          "/",
          templateHtml
        );
        const scripts = extractHtmlScripts(transformedHtml);
        injectedHeadScripts = scripts.flatMap((script) => script.content ?? []).join(";");
        if (devSsrStylesEnabled) {
          viteDevServer.middlewares.use(async (req, res, next) => {
            const url = req.url ?? "";
            const pathname = url.split("?")[0];
            if (!pathname?.endsWith("/@tanstack-start/styles.css")) {
              return next();
            }
            try {
              const urlObj = new URL(url, "http://localhost");
              const routesParam = urlObj.searchParams.get("routes");
              const routeIds = routesParam ? routesParam.split(",") : [];
              const entries = [];
              const routesManifest = globalThis.TSS_ROUTES_MANIFEST;
              if (routesManifest && routeIds.length > 0) {
                for (const routeId of routeIds) {
                  const route = routesManifest[routeId];
                  if (route?.filePath) {
                    entries.push(route.filePath);
                  }
                }
              }
              const css = entries.length > 0 ? await collectDevStyles({
                viteDevServer,
                entries,
                cssModulesCache
              }) : void 0;
              res.setHeader("Content-Type", "text/css");
              res.setHeader("Cache-Control", "no-store");
              res.end(css ?? "");
            } catch (e) {
              console.error("[tanstack-start] Error collecting dev styles:", e);
              res.setHeader("Content-Type", "text/css");
              res.setHeader("Cache-Control", "no-store");
              res.end(
                `/* Error collecting styles: ${e instanceof Error ? e.message : String(e)} */`
              );
            }
          });
        }
        return () => {
          const serverEnv = viteDevServer.environments[VITE_ENVIRONMENT_NAMES.server];
          if (!serverEnv) {
            throw new Error(
              `Server environment ${VITE_ENVIRONMENT_NAMES.server} not found`
            );
          }
          const { startConfig } = getConfig();
          const installMiddleware = startConfig.vite?.installDevServerMiddleware;
          if (installMiddleware === false) {
            return;
          }
          if (installMiddleware == void 0) {
            if (viteDevServer.config.server.middlewareMode) {
              return;
            }
            if (!isRunnableDevEnvironment(serverEnv) || // do not check via `isFetchableDevEnvironment` since nitro does implement the `FetchableDevEnvironment` interface but not via inheritance (which this helper checks)
            "dispatchFetch" in serverEnv) {
              return;
            }
          }
          if (!isRunnableDevEnvironment(serverEnv)) {
            throw new Error(
              "cannot install vite dev server middleware for TanStack Start since the SSR environment is not a RunnableDevEnvironment"
            );
          }
          viteDevServer.middlewares.use(async (req, res) => {
            if (req.originalUrl) {
              req.url = req.originalUrl;
            }
            const webReq = new NodeRequest({ req, res });
            try {
              const serverEntry = await serverEnv.runner.import(
                ENTRY_POINTS.server
              );
              const webRes = await serverEntry["default"].fetch(webReq);
              return sendNodeResponse(res, webRes);
            } catch (e) {
              console.error(e);
              try {
                viteDevServer.ssrFixStacktrace(e);
              } catch {
              }
              if (webReq.headers.get("content-type")?.includes("application/json")) {
                return sendNodeResponse(
                  res,
                  new Response(
                    JSON.stringify(
                      {
                        status: 500,
                        error: "Internal Server Error",
                        message: "An unexpected error occurred. Please try again later.",
                        timestamp: (/* @__PURE__ */ new Date()).toISOString()
                      },
                      null,
                      2
                    ),
                    {
                      status: 500,
                      headers: {
                        "Content-Type": "application/json"
                      }
                    }
                  )
                );
              }
              return sendNodeResponse(
                res,
                new Response(
                  `
              <!DOCTYPE html>
              <html lang="en">
                <head>
                  <meta charset="UTF-8" />
                  <title>Error</title>
                  <script type="module">
                    import { ErrorOverlay } from '/@vite/client'
                    document.body.appendChild(new ErrorOverlay(${JSON.stringify(
                    prepareError(req, e)
                  ).replace(/</g, "\\u003c")}))
                  <\/script>
                </head>
                <body>
                </body>
              </html>
            `,
                  {
                    status: 500,
                    headers: {
                      "Content-Type": "text/html"
                    }
                  }
                )
              );
            }
          });
        };
      }
    },
    {
      name: "tanstack-start-core:dev-server:injected-head-scripts",
      sharedDuringBuild: true,
      applyToEnvironment: (env) => env.config.consumer === "server",
      resolveId: {
        filter: { id: new RegExp(VIRTUAL_MODULES.injectedHeadScripts) },
        handler(_id) {
          return resolveViteId(VIRTUAL_MODULES.injectedHeadScripts);
        }
      },
      load: {
        filter: {
          id: new RegExp(resolveViteId(VIRTUAL_MODULES.injectedHeadScripts))
        },
        handler() {
          const mod = `
        export const injectedHeadScripts = ${JSON.stringify(injectedHeadScripts) || "undefined"}`;
          return mod;
        }
      }
    }
  ];
}
function prepareError(req, error) {
  const e = error;
  return {
    message: `An error occurred while server rendering ${req.url}:

	${typeof e === "string" ? e : e.message} `,
    stack: typeof e === "string" ? "" : e.stack
  };
}
export {
  devServerPlugin
};
//# sourceMappingURL=plugin.js.map
