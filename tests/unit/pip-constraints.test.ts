import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { applyBuildPipConstraints, parseBuildPipConstraints } from "../../src/infrastructure/containers/pip-constraints.js";

const roots: string[] = [];
const signal = () => AbortSignal.timeout(5000);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(recipe: string) {
  const root = await mkdtemp(join(tmpdir(), "pip-constraints-")); roots.push(root);
  const dockerfile = join(root, "Dockerfile"); await writeFile(dockerfile, recipe);
  return { root, dockerfile };
}

test("build pip constraints copy per-task bounds and reject options, URLs and duplicate packages", () => {
  expect(parseBuildPipConstraints()).toEqual({});
  const input = { "*": [" pytest>=7,<8 "], "workbuddy/example": [] };
  const parsed = parseBuildPipConstraints(input);
  input["*"][0] = "pytest>=9";
  expect(parsed).toEqual({ "*": ["pytest>=7,<8"], "workbuddy/example": [] });
  for (const value of [null, [], { "": [] }, { a: "pytest<8" }, { a: ["--index-url=https://private.invalid"] },
    { a: ["pytest @ https://private.invalid/p.whl"] }, { a: ["pytest<8\nanyio<4"] }, { a: [false] },
    { a: ["pytest"] }, { a: ["pytest<8;python_version>'3'"] }, { a: ["pytest<8", "PyTest==7.4.4"] }])
    expect(() => parseBuildPipConstraints(value)).toThrow(/buildPipConstraints/);
});

test("constraints reach each build stage without rewriting heredocs or repeating after USER", async () => {
  const recipe = "FROM python:3.12-slim AS first\nUSER nobody\nRUN <<'EOF'\nFROM fake\nEOF\nFROM first\nRUN pip install pytest\n";
  const { root, dockerfile } = await fixture(recipe);
  await writeFile(join(root, ".dockerignore"), "**\n");
  await applyBuildPipConstraints(root, dockerfile, ["pytest<8", "anyio<4.15"], signal());
  const built = await readFile(dockerfile, "utf8");
  expect(built.match(/^COPY --chmod=0644 /gmu)).toHaveLength(2);
  expect(built.match(/^ENV PIP_CONSTRAINT=/gmu)).toHaveLength(2);
  expect(built).toContain("USER nobody\nRUN <<'EOF'\nFROM fake\nEOF");
  expect(await readFile(join(root, ".evaluator-pip-constraints.txt"), "utf8")).toBe("pytest<8\nanyio<4.15\n");
  expect(await readFile(join(root, ".dockerignore"), "utf8")).toContain("!/.evaluator-pip-constraints.txt\n");
});

test("Dockerfile-specific ignore rules take priority while the root ignore stays unchanged", async () => {
  const { root } = await fixture("FROM ignored\n");
  await mkdir(join(root, "docker"));
  const dockerfile = join(root, "docker/task.Dockerfile");
  await writeFile(dockerfile, "FROM python:3.12-slim\n");
  await writeFile(dockerfile + ".dockerignore", "**\n");
  await writeFile(join(root, ".dockerignore"), "root-only\n");
  await applyBuildPipConstraints(root, dockerfile, ["pytest<8"], signal());
  expect(await readFile(dockerfile + ".dockerignore", "utf8")).toContain("!/.evaluator-pip-constraints.txt");
  expect(await readFile(join(root, ".dockerignore"), "utf8")).toBe("root-only\n");
});

test("disabled constraints leave the recipe unchanged and reserved files are not overwritten", async () => {
  const { root, dockerfile } = await fixture("FROM base\n");
  await applyBuildPipConstraints(root, dockerfile, [], signal());
  expect(await readFile(dockerfile, "utf8")).toBe("FROM base\n");
  await writeFile(join(root, ".evaluator-pip-constraints.txt"), "original");
  await expect(applyBuildPipConstraints(root, dockerfile, ["pytest<8"], signal())).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(join(root, ".evaluator-pip-constraints.txt"), "utf8")).toBe("original");
});
