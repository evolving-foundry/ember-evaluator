#!/usr/bin/env node
// Git-pinned SDK code cannot be replaced by similarly numbered PyPI releases.
// usage: node rewrite-requirements.mjs <pyproject.toml> <openjiuwen.whl> <intelli_router.whl>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [target, sdkWheel, routerWheel, ...rest] = process.argv.slice(2);
if (!target || !sdkWheel || !routerWheel || rest.length > 0) {
  console.error("usage: rewrite-requirements.mjs <pyproject.toml> <openjiuwen.whl> <intelli_router.whl>");
  process.exit(2);
}
const sdkRequirement = `openjiuwen @ ${pathToFileURL(sdkWheel).href}`;
const original = readFileSync(target, "utf8");
const newline = original.includes("\r\n") ? "\r\n" : "\n";
const rewritten = original.split(/\r?\n/u)
  .filter(line => !/^\s*openjiuwen\s*=\s*\{/u.test(line))
  .join(newline)
  .replaceAll(/"openjiuwen @ git\+[^"]*"/gu, `"${sdkRequirement}"`);
const requirements = rewritten.split(/\r?\n/u).map(line => line.trim())
  .filter(line => line.startsWith('"') && line.endsWith('",'));
if (requirements.some(line => line.includes("git+")) || !rewritten.includes(`"${sdkRequirement}"`)) {
  console.error("unrewritten Git requirements remain or the pinned openjiuwen requirement is missing");
  process.exit(1);
}
writeFileSync(target, rewritten);
// The SDK declares intelli-router through Git as well; override its source.
// Match the companion uv.lock. filelock 4 changes async lock ownership: the
// pinned SDK acquires/releases in different tasks and deadlocks after release.
writeFileSync(join(dirname(target), "evaluator-overrides.txt"), `intelli-router @ ${pathToFileURL(routerWheel).href}\nfilelock==3.29.0\n`);
console.log(`rewrote openjiuwen and intelli-router to local pinned wheels in ${target}`);
