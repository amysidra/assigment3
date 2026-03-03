import babel from "@babel/core";
import * as t from "@babel/types";
import { parseImportProtectionAst } from "./ast.js";
function findPostCompileUsagePos(code, source) {
  return findPostCompileUsagePosFromAst(parseImportProtectionAst(code), source);
}
function findPostCompileUsagePosFromAst(ast, source) {
  const imported = /* @__PURE__ */ new Set();
  for (const node of ast.program.body) {
    if (t.isImportDeclaration(node) && node.source.value === source) {
      if (node.importKind === "type") continue;
      for (const s of node.specifiers) {
        if (t.isImportSpecifier(s) && s.importKind === "type") continue;
        imported.add(s.local.name);
      }
    }
  }
  if (imported.size === 0) return void 0;
  let preferred;
  let anyUsage;
  try {
    babel.traverse(ast, {
      ImportDeclaration(path) {
        path.skip();
      },
      Identifier(path) {
        if (preferred && anyUsage) {
          path.stop();
          return;
        }
        const { node, parent, scope } = path;
        if (!imported.has(node.name)) return;
        if (path.isBindingIdentifier()) return;
        if (t.isObjectProperty(parent) && parent.key === node && !parent.computed && !parent.shorthand)
          return;
        if (t.isObjectMethod(parent) && parent.key === node && !parent.computed)
          return;
        if (t.isExportSpecifier(parent) && parent.exported === node) return;
        const binding = scope.getBinding(node.name);
        if (binding && binding.kind !== "module") return;
        const loc = node.loc?.start;
        if (!loc) return;
        const pos = { line: loc.line, column0: loc.column };
        const isPreferred = t.isCallExpression(parent) && parent.callee === node || t.isNewExpression(parent) && parent.callee === node || t.isMemberExpression(parent) && parent.object === node;
        if (isPreferred) {
          preferred ||= pos;
        } else {
          anyUsage ||= pos;
        }
      }
    });
  } catch {
    return void 0;
  }
  return preferred ?? anyUsage;
}
export {
  findPostCompileUsagePos
};
//# sourceMappingURL=postCompileUsage.js.map
