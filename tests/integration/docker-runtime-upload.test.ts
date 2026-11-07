import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { EnvironmentSession, EnvironmentSpec } from "../../src/core/contracts/environment.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { readProcess } from "../../src/infrastructure/process/output.js";

const enabled = process.env.EVALUATOR_TEST_DOCKER === "1" && process.platform === "linux";

test.skipIf(!enabled).each(["nobody", "dev"] as const)(
  "runtime uploads belong to the actual %s solver and leave other state untouched", async user => {
    const root = await mkdtemp(join(tmpdir(), "evaluator-runtime-upload-"));
    const image = `evaluator-runtime-upload-${randomUUID()}`;
    const signal = () => AbortSignal.timeout(180_000);
    const docker = (args: string[]) => runDockerCommand("docker", args, { signal: signal() });
    let session: EnvironmentSession | undefined;
    try {
      // dev intentionally differs from both root and the usual host UID 1000.
      await writeFile(join(root, "Dockerfile"), `FROM ${PINNED_NODE_IMAGE}\n` +
        "RUN groupadd -g 2002 dev && useradd -m -u 2001 -g 2002 dev\n" +
        `USER ${user === "nobody" ? "nobody" : "0:0"}\n`);
      await docker(["build", "--platform", "linux/amd64", "--tag", image, root]);
      const shared = join(root, "shared.txt");
      await writeFile(shared, "immutable runtime", { mode: 0o600 });
      const spec: EnvironmentSpec = {
        image, workdir: "/tmp", runtime: [], initialFiles: [], network: "none",
        installation: { id: "upload-permissions-fixture", files: [{ source: shared, target: "shared.txt" }], commands: [], probes: [] },
        ...(user === "dev" ? { executionUsers: { solve: "dev", verify: "root" } } : {}),
      };
      const attempt = join(root, "attempt");
      session = await new DockerEnvironment().prepare(spec, {
        root: attempt, agent: join(attempt, "agent"), verifier: join(attempt, "verifier"), artifacts: join(attempt, "artifacts"),
      }, "solve", signal());
      const activeSession = session;
      const execute = async (code: string) => {
        const result = await readProcess(await activeSession.start({ executable: "node", args: ["-e", code],
          cwd: activeSession.workdir, env: {}, input: null }, signal()), signal());
        expect(result.code, result.stderr).toBe(0);
        return result.stdout;
      };
      const runtime = session.runtime!;
      const stateRoot = runtime.stateRoot!;
      const state = `${stateRoot}/candidate`;
      const bundle = join(root, "bundle");
      await mkdir(join(bundle, "private"), { recursive: true });
      await chmod(bundle, 0o700);
      await chmod(join(bundle, "private"), 0o700);
      await writeFile(join(bundle, "private/settings.yaml"), "fixture: true\n", { mode: 0o600 });
      await writeFile(join(bundle, "check"), "#!/bin/sh\nprintf uploaded", { mode: 0o700 });
      await session.upload(bundle, `${state}/bundle`, signal());
      // An existing link inside the destination must never change its target.
      await execute(`require('fs').symlinkSync(${JSON.stringify(runtime.root + "/shared.txt")},${JSON.stringify(state + "/bundle/outside-link")})`);
      await session.upload(bundle, `${state}/bundle`, signal());
      const expectedUid = user === "dev" ? 2001 : 65534;
      const expectedGid = user === "dev" ? 2002 : 65534;
      const check = `const f=require('node:fs');const s=${JSON.stringify(state)};
        if(process.getuid()!==${expectedUid}||process.getgid()!==${expectedGid})throw Error('wrong solver user');
        for(const [p,m] of [[s,0o700],[s+'/bundle',0o700],[s+'/bundle/private',0o700],[s+'/bundle/private/settings.yaml',0o600],[s+'/bundle/check',0o700]]){
          const st=f.statSync(p);if(st.uid!==process.getuid()||st.gid!==process.getgid()||(st.mode&0o777)!==m)throw Error('wrong owner/mode: '+p);
        }
        if(f.readFileSync(s+'/bundle/private/settings.yaml','utf8')!=='fixture: true\\n')throw Error('config unreadable');
        if(require('node:child_process').execFileSync(s+'/bundle/check',{encoding:'utf8'})!=='uploaded')throw Error('lost execute permission');
        f.writeFileSync(s+'/registry.json','{}',{mode:0o600});
        const shared=f.statSync(${JSON.stringify(runtime.root + "/shared.txt")});
        if(shared.uid!==0||(shared.mode&0o777)!==0o644)throw Error('symlink target changed');
        if((f.statSync(${JSON.stringify(stateRoot)}).mode&0o7777)!==0o1777)throw Error('state root changed');`;
      await execute(check);
      // A later file upload must not visit or take ownership of cached state.
      await docker(["exec", "--user", "0:0", session.id, "node", "-e",
        `const f=require('fs');f.mkdirSync(${JSON.stringify(state + "/cache")},{mode:0o700});f.writeFileSync(${JSON.stringify(state + "/cache/keep")},'private',{mode:0o600});f.chmodSync(${JSON.stringify(state + "/cache")},0);`]);
      const patch = join(root, "permissions.patch.yaml");
      await writeFile(patch, "permissions: fixture\n", { mode: 0o600 });
      await session.upload(patch, `${state}/permissions.patch.yaml`, signal());
      await execute(`const f=require('fs');const p=${JSON.stringify(state + "/permissions.patch.yaml")};
        if(f.readFileSync(p,'utf8')!=='permissions: fixture\\n')throw Error('patch unreadable');
        if(f.statSync(p).uid!==process.getuid()||(f.statSync(p).mode&0o777)!==0o600)throw Error('wrong patch permissions');
        const c=f.statSync(${JSON.stringify(state + "/cache")});if(c.uid!==0||(c.mode&0o777)!==0)throw Error('unrelated cache changed');`);
      // Reject parent and final symlinks; never hand an outside target to Solver.
      await execute(`require('fs').symlinkSync('/tmp',${JSON.stringify(state + "/escape")})`);
      await expect(session.upload(patch, `${state}/escape/probe`, signal())).rejects.toThrow();
      await expect(session.upload(patch, `${state}/bundle/outside-link`, signal())).rejects.toThrow();
      await expect(session.upload(patch, stateRoot, signal())).rejects.toMatchObject({ code: "TRANSFER_UNSAFE" });
      if (user === "dev") {
        await session.transitionToVerification?.("none", signal());
        expect(await execute("console.log(process.getuid())")).toBe("0\n");
        await session.transitionToSolve?.("none", signal(), spec.executionUsers);
        await execute(check);
        await session.upload(patch, `${state}/permissions.patch.yaml`, signal());
        expect(await execute(`console.log(require('fs').statSync(${JSON.stringify(state + "/permissions.patch.yaml")}).uid)`)).toBe("2001\n");
      }
    } finally {
      try { await session?.dispose(signal()); }
      finally {
        await runDockerCommand("docker", ["image", "rm", image], { signal: signal() }).catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 240_000,
);
