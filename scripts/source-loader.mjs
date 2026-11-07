// Lets a checkout run the TypeScript sources directly:
//   node --experimental-transform-types --import ./scripts/source-loader.mjs src/cli.ts
// TypeScript sources import `./foo.js` while the file on disk is `foo.ts`, so resolution
// falls back to the source file whenever the compiled output is missing.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_SOURCE = resolve(ROOT, "src/index.ts");
const PACKAGE_BUILD = resolve(ROOT, "dist/index.js");

function sourceFile(specifier, parentURL) {
  if (!parentURL?.startsWith("file:") || !specifier.startsWith(".") || !specifier.endsWith(".js")) return undefined;
  const path = fileURLToPath(new URL(specifier, parentURL));
  const source = `${path.slice(0, -3)}.ts`;
  return !existsSync(path) && existsSync(source) ? pathToFileURL(source).href : undefined;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Self-reference imports fall back to the package sources in an unbuilt checkout.
    if (specifier === "ember-evaluator" && !existsSync(PACKAGE_BUILD) && existsSync(PACKAGE_SOURCE)) {
      return { url: pathToFileURL(PACKAGE_SOURCE).href, shortCircuit: true };
    }
    const source = sourceFile(specifier, context.parentURL);
    if (source) return { url: source, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
