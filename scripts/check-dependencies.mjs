import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

const root = fileURLToPath(new URL("../", import.meta.url));
const portable = value => value.replaceAll("\\", "/");
const pureConfig = new Set(["defaults", "loaded", "effective", "user-schema", "resolve", "redact", "hardware", "deployment", "jobs", "network-schema", "profile-schema", "ray"]);
const allowed = {
  core: new Set(["core"]), config: new Set(["core", "config"]),
  infrastructure: new Set(["core", "config", "infrastructure"]),
  runtimes: new Set(["core", "config", "infrastructure", "runtimes"]),
  plugins: new Set(["core", "config", "infrastructure", "runtimes", "plugins"]),
  application: new Set(["core", "config", "infrastructure", "runtimes", "plugins", "application"]),
  cli: new Set(["application", "core", "cli"]),
};

export function imports(ast) {
  const result = [];
  const add = (node, typeOnly = false) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) result.push({ specifier: node.text, typeOnly });
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      add(node.moduleSpecifier, !!clause?.isTypeOnly || !!(clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length && named.elements.every(item => item.isTypeOnly)));
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node.isTypeOnly || !!(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(item => item.isTypeOnly)));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) add(node.arguments[0]);
    node.forEachChild(visit);
  };
  visit(ast);
  return result;
}

export function inspectDependencies(directory = root) {
  const src = resolve(directory, "src");
  const files = readdirSync(src, { recursive: true }).map(portable).filter(file => /\.(?:ts|mjs|js)$/.test(file) && !file.includes("/assets/"));
  const config = portable(resolve(directory, "tsconfig.dependencies.json"));
  const api = new API({ cwd: directory, fs: {
    fileExists: file => portable(file) === config ? true : undefined,
    readFile: file => portable(file) === config ? JSON.stringify({ compilerOptions: { allowJs: true, noResolve: true }, files: files.map(file => `src/${file}`) }) : undefined,
  } });
  const snapshot = api.updateSnapshot({ openProjects: [config] });
  const program = snapshot.getProject(config).program;
  const graph = new Map(files.map(file => [file, []]));
  const violations = new Set();
  try { for (const file of files) {
    for (const edge of imports(program.getSourceFile(resolve(src, file)))) {
      const name = edge.specifier;
      if (name === "ember-evaluator" || name.startsWith("ember-evaluator/")) {
        violations.add(`boundary:${file} -> ${name}`); continue;
      }
      if (!name.startsWith(".")) continue;
      let base = resolve(src, dirname(file), name);
      // Source process entries import the build when run directly from a checkout.
      // Apply the same rules to those imports instead of treating dist as external.
      const built = portable(relative(resolve(directory, "dist"), base));
      if (!built.startsWith("../") && !built.startsWith("/")) base = resolve(src, built);
      const candidates = [base.replace(/\.js$/, ".ts"), base, resolve(base, "index.ts")];
      const target = candidates.map(item => portable(relative(src, item))).find(item => graph.has(item));
      if (!target) { violations.add(`missing:${file} -> ${name}`); continue; }
      if (!edge.typeOnly) graph.get(file).push(target);
      if (["index.ts", "cli.ts"].includes(file)) continue;
      const from = file.split("/")[0], to = target.split("/")[0];
      const set = allowed[from];
      const impure = to === "config" && !["config", "application"].includes(from) && !pureConfig.has(target.slice(7, -extname(target).length));
      const orchestration = ["infrastructure", "runtimes", "config"].includes(from) && /^core\/execution\//.test(target);
      if (!set || !set.has(to) || impure || orchestration || target === "index.ts") violations.add(`boundary:${file} -> ${target}`);
    }
  } } finally { api.close(); }
  // Only executable imports participate in initialization cycles. Type-only edges
  // still obey boundaries but recursive structural contracts do not execute code.
  const visited = new Set(), active = new Set(), stack = [];
  const walk = file => {
    if (active.has(file)) {
      const cycle = stack.slice(stack.indexOf(file));
      for (let i = 0; i < cycle.length; i++) violations.add(`cycle:${cycle[i]} -> ${cycle[(i + 1) % cycle.length]}`);
      return;
    }
    if (visited.has(file)) return;
    active.add(file); stack.push(file);
    for (const target of graph.get(file)) walk(target);
    stack.pop(); active.delete(file); visited.add(file);
  };
  for (const file of files) walk(file);
  return [...violations].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baselinePath = resolve(root, "scripts/dependency-baseline.json");
  const actual = inspectDependencies();
  if (process.argv.includes("--initialize")) {
    if (existsSync(baselinePath)) throw new Error("The migration baseline already exists; adding exemptions is not allowed");
    writeFileSync(baselinePath, JSON.stringify(actual, null, 2) + "\n");
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (process.argv.includes("--prune")) writeFileSync(baselinePath, JSON.stringify(baseline.filter(item => actual.includes(item)), null, 2) + "\n");
  const unexpected = actual.filter(item => !baseline.includes(item));
  if (unexpected.length) {
    process.stderr.write(unexpected.join("\n") + "\n"); process.exitCode = 1;
  } else process.stdout.write(`Dependency boundaries: ${actual.length} known migration violations, no new violations\n`);
}
