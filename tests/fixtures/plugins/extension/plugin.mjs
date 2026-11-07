import { appendFile } from "node:fs/promises";

export const inject = ["evaluator"];
export function registerCli(cli) {
  cli.extendCommand("run", {
    flags: "--audit-url <url>", description: "Enable the fixture audit extension",
    configure(url, activation) { activation.enable({ url }); },
  });
}
export function apply(ctx) {
  ctx.evaluator.registerStoreDecorator("record-open", value => {
    if (typeof value.url !== "string") throw new TypeError("audit url is required");
    return value;
  }, (config, runtime) => inner => new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "open" || property === "create") return async (...args) => {
        await appendFile(runtime.resolvePath("audit.jsonl"), JSON.stringify({ operation: property, config }) + "\n");
        return value.apply(target, args);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  }));
}
