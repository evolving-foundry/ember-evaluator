import { expect, test } from "vitest";
import { aptSourceInstructions } from "../../src/infrastructure/containers/apt-sources.js";
import { insertDockerfileStageSettings } from "../../src/infrastructure/containers/dockerfile.js";

const injectTaskBuildInstructions = (recipe: string, setup: string[]) => insertDockerfileStageSettings(recipe, setup, undefined, true);

test("a root switch after a non-root base retries mirrors before package installation", () => {
  const instructions = aptSourceInstructions({ debian: String("http://mirror.example").replace(/\/$/u, "") + "/debian", debianSecurity: String("http://mirror.example").replace(/\/$/u, "") + "/debian-security", ubuntu: String("http://mirror.example").replace(/\/$/u, "") + "/ubuntu", ubuntuSecurity: String("http://mirror.example").replace(/\/$/u, "") + "/ubuntu", ubuntuPorts: String("http://mirror.example").replace(/\/$/u, "") + "/ubuntu-ports" });
  const recipe = "FROM conda:locked\nUSER root\nRUN apt-get update\nUSER app\nRUN python answer.py\n";
  const rewritten = injectTaskBuildInstructions(recipe, instructions);
  expect(rewritten).toContain(`USER root\n${instructions.join("\n")}\nRUN apt-get update`);
  expect(rewritten).toContain(`USER app\n${instructions.join("\n")}\nRUN python answer.py`);
  expect(instructions.join("\n")).toContain('[ "$(id -u)" = 0 ]');
  expect(rewritten.match(/^USER .+$/gmu)).toEqual(["USER root", "USER app"]);
});

test("USER and FROM lines inside a task heredoc remain task content", () => {
  const recipe = "FROM base\nRUN cat > /app/example <<'EOF'\nUSER root\nFROM sample\nEOF\nUSER root\nRUN apt-get update\n";
  const rewritten = injectTaskBuildInstructions(recipe, ["RUN setup"]);
  expect(rewritten).toContain("<<'EOF'\nUSER root\nFROM sample\nEOF\nUSER root\nRUN setup\nRUN apt-get update");
  expect(rewritten.match(/^RUN setup$/gmu)).toHaveLength(2);
});

test("multi-stage and indented recipes apply setup to each stage without accepting missing FROM", () => {
  const setup = aptSourceInstructions({ debian: String("https://mirror.example").replace(/\/$/u, "") + "/debian", debianSecurity: String("https://mirror.example").replace(/\/$/u, "") + "/debian-security", ubuntu: String("https://mirror.example").replace(/\/$/u, "") + "/ubuntu", ubuntuSecurity: String("https://mirror.example").replace(/\/$/u, "") + "/ubuntu", ubuntuPorts: String("https://mirror.example").replace(/\/$/u, "") + "/ubuntu-ports" });
  const recipe = "  FROM one AS build\n  USER 0:0\nRUN prepare\nFROM two\nRUN install\n";
  const rewritten = injectTaskBuildInstructions(recipe, setup);
  expect(rewritten.split(setup.join("\n"))).toHaveLength(4);
  expect(rewritten).toContain(`  USER 0:0\n${setup.join("\n")}\nRUN prepare`);
  expect(setup[0]).toContain('[ "$(id -u)" = 0 ]');
  expect(injectTaskBuildInstructions("USER root\nRUN apt-get update\n", setup)).toBe("USER root\nRUN apt-get update\n");
});
