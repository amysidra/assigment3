import { TSS_SERVER_FUNCTION } from "@tanstack/start-client-core";
const createServerRpc = (serverFnMeta, splitImportFn) => {
  const url = process.env.TSS_SERVER_FN_BASE + serverFnMeta.id;
  return Object.assign(splitImportFn, {
    url,
    serverFnMeta,
    [TSS_SERVER_FUNCTION]: true
  });
};
export {
  createServerRpc
};
//# sourceMappingURL=createServerRpc.js.map
