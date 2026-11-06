import { posix } from "node:path";

/** Static WORKDIR projection only; never execute Dockerfile expressions on the host. */
export function inferDockerWorkdir(dockerfile: string | null): string {
  if (dockerfile === null) return "/testbed";
  const unresolved = (): never => {
    throw new Error(
      "Cannot infer Dockerfile WORKDIR; set environment.workdir or benchmark.config.taskProfiles for this task",
    );
  };
  // These forms need a full Dockerfile interpreter; do not read heredoc contents as instructions.
  if (/^\s*#\s*escape\s*=\s*`/im.test(dockerfile)) return unresolved();
  const stages = new Map<string, { workdir: string | null; declared: boolean }>();
  let stage: string | undefined;
  let workdir: string | null = null;
  let declared = false;
  const lines = dockerfile.replace(/\\\r?\n/g, "").split(/\r?\n/);
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  for (const line of lines) {
    const pending = heredocs[0];
    if (pending) {
      if ((pending.stripTabs ? line.replace(/^\t+/u, "") : line) === pending.delimiter) heredocs.shift();
      continue;
    }
    if (/^\s*(?:RUN|COPY|ADD)\s/iu.test(line)) {
      for (const match of line.matchAll(/<<(-?)[ \t]*(?:["']([A-Za-z_][\w-]*)["']|([A-Za-z_][\w-]*))/gu))
        heredocs.push({ delimiter: match[2] ?? match[3] ?? "", stripTabs: match[1] === "-" });
      if (heredocs.length) continue;
    }
    const instruction = /^\s*(FROM|WORKDIR)\s+(.+?)\s*$/i.exec(line);
    if (!instruction) continue;
    const value = instruction[2]!;
    if (instruction[1]!.toUpperCase() === "FROM") {
      if (stage !== undefined) stages.set(stage, { workdir, declared });
      const from = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(value);
      if (!from) return unresolved();
      const inherited = stages.get(from[1]!.toLowerCase());
      workdir = inherited?.workdir ?? null;
      declared = inherited?.declared ?? false;
      stage = from[2]?.toLowerCase();
      continue;
    }
    declared = true;
    const path = value.replace(/^(["'])(.*)\1$/, "$2");
    if (!path || /[$\\\0\r\n"'\[\]]/.test(path)) {
      workdir = null;
      continue;
    }
    if (posix.isAbsolute(path)) workdir = posix.normalize(path);
    else workdir = workdir === null ? null : posix.resolve(workdir, path);
  }
  if (heredocs.length) return unresolved();
  if (declared && workdir === null) return unresolved();
  return workdir ?? "/testbed";
}
