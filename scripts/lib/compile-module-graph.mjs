import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

async function sourceUrl(specifier, importer) {
  const candidate = new URL(specifier, importer);
  for (const suffix of ["", ".ts", ".tsx", ".mjs", ".js"]) {
    const url = new URL(`${candidate.href}${suffix}`);
    try { if ((await stat(url)).isFile()) return url; } catch { /* Try the next source extension. */ }
  }
  throw new Error(`Cannot resolve ${specifier} from ${importer.href}`);
}

/** Compile actual local modules while applying the same service mocks throughout
 * their dependency graph. The generated files are isolated from application env.
 * Existing route-relative mock maps keep working after domain modules move.
 */
export async function compileModuleGraph(entry, replacements = {}, { replacementBase } = {}) {
  const entryUrl = entry instanceof URL ? entry : pathToFileURL(entry);
  const directory = await mkdtemp(join(tmpdir(), "personnel-module-test-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  const pending = [];
  try {
    const mocks = new Map();
    for (const [specifier, target] of Object.entries(replacements)) {
      const key = specifier.startsWith(".") ? (await sourceUrl(specifier, replacementBase ?? entryUrl)).href : specifier;
      mocks.set(key, target);
    }
    const outputs = new Map();

    function outputFor(url) {
      if (outputs.has(url.href)) return outputs.get(url.href);
      const output = pathToFileURL(join(directory, `${createHash("sha256").update(url.href).digest("hex").slice(0, 20)}.mjs`));
      outputs.set(url.href, output);
      pending.push(compile(url, output));
      return output;
    }

    async function resolve(specifier, importer) {
      if (!specifier.startsWith(".")) return mocks.get(specifier) ?? (specifier.startsWith("node:") ? specifier : import.meta.resolve(specifier));
      const url = await sourceUrl(specifier, importer);
      return mocks.get(url.href) ?? outputFor(url).href;
    }

    async function compile(url, output) {
      const source = await readFile(url, "utf8");
      const compiled = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
      }, fileName: fileURLToPath(url) }).outputText;
      const ast = ts.createSourceFile("module.mjs", compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const specifiers = [];
      function visit(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0]);
        ts.forEachChild(node, visit);
      }
      visit(ast);
      const edits = await Promise.all(specifiers.map(async node => ({
        start: node.getStart(ast), end: node.end, text: JSON.stringify(await resolve(node.text, url)),
      })));
      let result = compiled;
      for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      await writeFile(output, result);
    }

    const result = outputFor(entryUrl);
    // Compilation discovers further dependencies. Await every discovered module
    // before loading any generated file, including shared and circular imports.
    for (let index = 0; index < pending.length; index++) await pending[index];
    return { url: result.href, dispose };
  } catch (error) {
    // A dependency may already be compiling when another import fails. Finish
    // those tasks before removing their temporary output directory.
    for (let index = 0; index < pending.length; index++) await pending[index].catch(() => {});
    await dispose();
    throw error;
  }
}
