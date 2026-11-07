import type { ExecutionConfig } from "../core/contracts/config.js";
import type { Deployment } from "./deployment.js";

export type LoadedConfig = ExecutionConfig & { deployment?: Deployment };
