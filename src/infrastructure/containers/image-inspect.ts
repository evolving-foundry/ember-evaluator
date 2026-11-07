import type { DockerCommand } from "./runtime-contract.js";

/** Negotiate image selection once; never discover capabilities through failed inspection. */
export function platformImageCommand(command: DockerCommand): DockerCommand {
  let supportsPlatform: Promise<boolean> | undefined;
  return async (args, options) => {
    const index = args.indexOf("--platform");
    if (args[0] !== "image" || args[1] !== "inspect" || index < 0) return command(args, options);
    supportsPlatform ??= command(["version", "--format", "{{.Client.APIVersion}} {{.Server.APIVersion}}"], options)
      .then(result => {
        const versions = result.stdout.trim().split(/\s+/u);
        if (versions.length !== 2 || versions.some(value => !/^\d+\.\d+$/u.test(value))) throw new Error("Docker version did not provide client and server API capabilities");
        return versions.every(value => {
          const [major, minor] = value.split(".").map(Number);
          return major !== undefined && minor !== undefined && (major > 1 || (major === 1 && minor >= 49));
        });
      }).catch(error => { supportsPlatform = undefined; throw error; });
    // Classic stores expose one loaded variant. Base-image admission still
    // checks its OS/architecture; multi-platform stores use explicit selection.
    const selected = await supportsPlatform ? args : args.filter((_value, position) => position !== index && position !== index + 1);
    return command(selected, options);
  };
}
