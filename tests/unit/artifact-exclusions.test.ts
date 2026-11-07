import { expect, test } from "vitest";
import { artifactExcluded } from "../../src/infrastructure/filesystem/workspace-transfer.js";

test("artifact exclusions follow tar wildcard and directory semantics", () => {
  expect(artifactExcluded("src/nested/.cache.pyc", ["*.pyc"])).toBe(true);
  expect(artifactExcluded("src/deep/module.py", ["src/*.py"])).toBe(true);
  expect(artifactExcluded("nested/__pycache__/module.pyc", ["__pycache__"])).toBe(true);
  expect(artifactExcluded("megatron_parallel.py", ["./megatron_parallel.py"])).toBe(true);
  expect(artifactExcluded("nested/megatron_parallel.py", ["./megatron_parallel.py"])).toBe(false);
  expect(artifactExcluded("src/module.py", ["src/*.pyc"])).toBe(false);
  expect(artifactExcluded("src/__pycache__backup/module.py", ["__pycache__"])).toBe(false);
  expect(artifactExcluded(".next/cache", ["*"])).toBe(true);
});

test("artifact exclusions treat tar character classes and escaped or literal glob syntax correctly", () => {
  expect(artifactExcluded("test2.txt", ["test[0-9].txt"])).toBe(true);
  expect(artifactExcluded("testa.txt", ["test[!0-9].txt"])).toBe(true);
  expect(artifactExcluded("test2.txt", ["test[!0-9].txt"])).toBe(false);
  expect(artifactExcluded("test*.txt", ["test\\*.txt"])).toBe(true);
  expect(artifactExcluded("test2.txt", ["test\\*.txt"])).toBe(false);
  expect(artifactExcluded("test{a,b}.txt", ["test{a,b}.txt"])).toBe(true);
  expect(artifactExcluded("testa.txt", ["test{a,b}.txt"])).toBe(false);
  expect(artifactExcluded("[unclosed", ["[unclosed"])).toBe(true);
  expect(artifactExcluded("test2.txt", ["test[z-a].txt"])).toBe(false);
});
