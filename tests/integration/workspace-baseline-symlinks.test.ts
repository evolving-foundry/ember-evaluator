import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { workspaceHelperSource } from "../../src/infrastructure/filesystem/workspace-transfer.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")(
  "restores unchanged baseline symlinks without introducing new or changed unsafe links",
  () => {
    const image = process.env.EVALUATOR_TEST_DOCKER_IMAGE;
    if (!image) throw new Error("EVALUATOR_TEST_DOCKER_IMAGE must name a linux/amd64 image with Node 24, Git and tar");
    const script = `
      const fs = await import('node:fs/promises');
      const { execFileSync } = await import('node:child_process');
      await fs.mkdir('/opt/evaluator', { recursive: true });
      await fs.writeFile('/opt/evaluator/state.mjs', ${JSON.stringify(workspaceHelperSource)});
      await fs.mkdir('/workspace/sub', { recursive: true });
      await fs.writeFile('/outside', 'unchanged');
      await fs.mkdir('/outside-dir');
      await fs.symlink('/outside', '/outside-dir/child');
      await fs.symlink('/outside-dir', '/workspace/ancestor');
      await fs.writeFile('/workspace/file', 'base');
      await fs.symlink('../file', '/workspace/sub/parent');
      await fs.symlink('/outside', '/workspace/absolute');
      await fs.symlink('/outside', '/workspace/changed');
      const git = (...args) => execFileSync('git', args, { cwd: '/workspace', encoding: 'utf8' });
      git('init', '-q'); git('add', '.');
      git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
      await fs.writeFile('/workspace/analysis.json', '{}');
      await fs.unlink('/workspace/changed');
      await fs.symlink('/etc/passwd', '/workspace/changed');
      await fs.symlink('/outside', '/workspace/new-link');
      await fs.unlink('/workspace/ancestor');
      await fs.mkdir('/workspace/ancestor');
      await fs.symlink('/outside', '/workspace/ancestor/child');
      const helper = (...args) => execFileSync(process.execPath, ['/opt/evaluator/state.mjs', ...args]);
      helper('export', 'aaaa', JSON.stringify({ kind: 'workspace-archive', workdir: '/workspace', extraPaths: [] }));
      const archive = await fs.readFile('/opt/evaluator/transfers/aaaa/state.tar');
      const digest = (await import('node:crypto')).createHash('sha256').update(archive).digest('hex');
      await fs.rm('/workspace/ancestor', { recursive: true });
      git('reset', '--hard', '-q', 'HEAD');
      await fs.rm('/workspace/new-link'); await fs.rm('/workspace/analysis.json');
      helper('restore', 'aaaa', digest);
      const link = path => fs.readlink(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      console.log(JSON.stringify({ parent: await link('/workspace/sub/parent'), absolute: await link('/workspace/absolute'),
        changed: await link('/workspace/changed'), added: await link('/workspace/new-link'),
        ancestorChild: await link('/workspace/ancestor/child'), outsideChild: await link('/outside-dir/child'),
        outside: await fs.readFile('/outside', 'utf8'), analysis: await fs.readFile('/workspace/analysis.json', 'utf8'),
        diff: git('diff', '--name-only') }));
    `;
    const result = spawnSync("docker", ["run", "--rm", "--network=none", "--platform=linux/amd64", "--entrypoint=node",
      image, "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const value: unknown = JSON.parse(result.stdout);
    expect(value).toEqual({ parent: "../file", absolute: "/outside", changed: null, added: null,
      ancestorChild: null, outsideChild: "/outside", outside: "unchanged", analysis: "{}", diff: "ancestor\nchanged\n" });
  },
  70_000,
);
