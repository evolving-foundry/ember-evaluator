import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-distribution.mjs <installed-package-directory>");
const root = resolve(process.argv[2]);
await access(join(root, "dist/package-provenance.json"));
const fixtures = new URL("../tests/fixtures/", import.meta.url);
await mkdir(join(root, ".validation"), { recursive: true });
await cp(new URL("distribution/check.mjs", fixtures), join(root, "check-distribution.mjs"));
await cp(new URL("distribution/telemetry.py", fixtures), join(root, ".validation/telemetry.py"));
const plugin = await readFile(new URL("cli/plugin.mjs", fixtures), "utf8");
await writeFile(join(root, ".validation/base.mjs"), plugin);
await writeFile(join(root, ".validation/plugin.mjs"), `import { apply as base } from "./base.mjs";
import { writeFile } from "node:fs/promises";
export const inject = ["evaluator"];
export function apply(ctx) {
  base(ctx);
  ctx.evaluator.register("environment", "distribution-maintenance", x => x, (_, runtime) => ({
    async prepare() { throw new Error("maintenance does not allocate sessions"); },
    async cleanupImages() { return { nodeId: "fixture-node", items: [] }; },
    async acquireImageLease() { return async () => writeFile(runtime.resolvePath("lease-released"), "released"); },
  }));
}
`);
const child = spawn(process.execPath, [join(root, "check-distribution.mjs")], { cwd: root, stdio: "inherit", windowsHide: true });
process.exitCode = await new Promise((done, fail) => { child.once("error", fail); child.once("exit", code => done(code ?? 1)); });
