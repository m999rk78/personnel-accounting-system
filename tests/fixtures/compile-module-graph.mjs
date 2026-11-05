import { after } from "node:test";
import { compileModuleGraph as compileGraph } from "../../scripts/lib/compile-module-graph.mjs";

/** Keep generated module cleanup tied to the current test lifecycle. */
export async function compileModuleGraph(entry, replacements = {}, options) {
  const graph = await compileGraph(entry, replacements, options);
  after(graph.dispose);
  return graph.url;
}
