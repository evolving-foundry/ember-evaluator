import type { JsonValue } from "./task.js";
import type { RunStore } from "./run-store.js";
import type { PluginFactoryContext } from "../registry.js";

/** Persistable options only: use environment references for credentials. */
export type PluginActivation = { id: string; config: Record<string, JsonValue> };

export type PluginCliIO = { out(text: string): void; error(text: string): void };
export type PluginCliResult = { ok: true; status: number } | { ok: false; error: unknown; usage: boolean };
export type PluginCliCommand = {
  name: string;
  description: string;
  run(argv: string[], io: PluginCliIO, signal: AbortSignal): Promise<PluginCliResult>;
};
export type PluginCliOption = {
  flags: string;
  description: string;
  configure(value: unknown, activation: { enable(config: Record<string, JsonValue>): void }): void;
};
/** Registration must not start processes, open databases, or perform network I/O. */
export interface PluginCliRegistrar {
  addCommand(command: PluginCliCommand): void;
  extendCommand(command: "run", option: PluginCliOption): void;
}

export type StoreDecorator = (inner: RunStore) => RunStore | Promise<RunStore>;
export type StoreDecoratorFactory<T> = (config: T, runtime: PluginFactoryContext) => StoreDecorator | Promise<StoreDecorator>;
