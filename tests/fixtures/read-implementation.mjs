import { readFile, stat } from "node:fs/promises";
import ts from "typescript";

// Existing source-level checks follow the reachable domain modules instead of
// depending on every declaration living in one large entry file.
async function readImplementation(entry, moduleDirectory) {
  const visited = new Set();
  async function visit(url) {
    if (visited.has(url.href)) return "";
    visited.add(url.href);
    const source = await readFile(url, "utf8");
    const ast = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, url.pathname.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const dependencies = [];
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (!statement.moduleSpecifier.text.startsWith(".")) continue;
      const target = new URL(statement.moduleSpecifier.text, url);
      if (!target.href.startsWith(moduleDirectory.href)) continue;
      for (const extension of ["", ".ts", ".tsx"]) {
        const candidate = new URL(`${target.href}${extension}`);
        try {
          if (!(await stat(candidate)).isFile()) continue;
          dependencies.push(await visit(candidate));
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    return `${source}\n${dependencies.join("\n")}`;
  }
  return visit(entry);
}

export const readDataImplementation = () => readImplementation(new URL("../../app/api/data/route.ts", import.meta.url), new URL("../../app/server/data/", import.meta.url));
export const readWorkspaceImplementation = () => readImplementation(new URL("../../app/PersonnelApp.tsx", import.meta.url), new URL("../../app/workspace/", import.meta.url));
export const readGridImplementation = async () => (await Promise.all([
  "AgDataGrids.tsx", "EmployeeDirectoryGrid.tsx", "bitrixEmployeeStatus.ts", "ReferenceDirectoryGrids.tsx",
  "EquipmentDirectoryGrids.tsx", "CatalogSpreadsheetGrid.tsx", "equipmentDirectorySpreadsheet.ts",
].map(file => readFile(new URL(`../../app/${file}`, import.meta.url), "utf8")))).join("\n");
