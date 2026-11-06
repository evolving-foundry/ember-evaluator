import { createHash } from "node:crypto";
import type { EnvironmentPreparationContext } from "../../core/contracts/environment.js";

export type DockerImageScope = EnvironmentPreparationContext & { service?: string };

function component(value: string, limit: number, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").slice(0, limit).replace(/^-+|-+$/gu, "") || fallback;
}

/** Names remain stable across runs; complete IDs disambiguate normalized short names. */
export function dockerImageName(kind: string, contentKey: string, scope?: DockerImageScope): string {
  const task = scope ? component(scope.taskId.split("/").at(-1) ?? "", 80, "task") : "shared";
  const service = scope?.service === undefined ? "" : `service-${component(scope.service, 32, "service")}-`;
  const prefix = scope ? `${scope.phase}-${service}` : "";
  const hash = createHash("sha256").update(JSON.stringify([scope?.taskId, scope?.phase, scope?.service, kind, contentKey])).digest("hex").slice(0, 24);
  return `ember-evaluator/${task}:${prefix}${kind}-${hash}`;
}
