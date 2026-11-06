import type { ContainerPlatform } from "../../core/contracts/environment.js";
import type { DockerCommand } from "./runtime-contract.js";

/** Preserve the image's USER, including numeric UID:GID, across runtime layers. */
export async function dockerImageUser(command: DockerCommand, image: string, platform: ContainerPlatform, signal: AbortSignal): Promise<string> {
  const { stdout } = await command(["image", "inspect", "--platform", platform, image, "--format", "{{json .Config.User}}"], { signal });
  const user: unknown = JSON.parse(stdout);
  if (typeof user !== "string" || (user !== "" && !/^[a-zA-Z0-9_.$-]+(?::[a-zA-Z0-9_.$-]+)?$/u.test(user)))
    throw new Error(`Invalid Docker image USER for ${image}`);
  return user || "0";
}
