import { fetch as fetchHttp, type Dispatcher } from "undici";
import { createNetworkDispatcher } from "./dispatcher.js";
import { networkEnvironment } from "./environment.js";
import { networkDocument, redactNetwork, networkSecrets } from "../../config/network-schema.js";
import type { NetworkAccess, NetworkDocument, NetworkLocation } from "../../core/contracts/network.js";

/** The instance owns dispatchers; creating one never changes global fetch or process.env. */
export class NetworkRuntime implements NetworkAccess {
  readonly settings;
  readonly secrets: string[];
  private dispatcher: Dispatcher | undefined;
  constructor(readonly document: NetworkDocument = networkDocument({}, process.env, "environment/defaults")) {
    this.fetch = this.fetch.bind(this);
    this.settings = document.settings;
    this.secrets = networkSecrets(document);
  }
  private client(): Dispatcher {
    const proxy = this.settings.proxy.host;
    return this.dispatcher ??= createNetworkDispatcher(proxy);
  }
  async fetch(input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> {
    // Node and the installed Undici can expose different Dispatcher versions.
    // Bridge their web objects instead of casting one Dispatcher's ABI to another.
    const request = new Request(input, init);
    const response = await fetchHttp(request.url, {
      method: request.method, headers: [...request.headers], signal: request.signal,
      redirect: request.redirect, dispatcher: this.client(),
      ...(request.body ? { body: request.body, duplex: "half" as const } : {}),
    });
    const result = new Response(response.body ? ReadableStream.from(response.body) : null, {
      status: response.status, statusText: response.statusText, headers: [...response.headers],
    });
    Object.defineProperties(result, { url: { value: response.url }, redirected: { value: response.redirected } });
    return result;
  }
  sourceUrl(value: string): string {
    const sources = this.settings.sources;
    for (const [prefix, replacement] of [
      ["https://huggingface.co", sources.huggingface],
      ["https://api.github.com", sources.github.api],
      ["https://raw.githubusercontent.com", sources.github.raw],
      ["https://github.com", sources.github.repository],
      ["https://nodejs.org/dist", sources.node.dist],
    ] as const) if (value === prefix || value.startsWith(prefix + "/")) return replacement + value.slice(prefix.length);
    return value;
  }
  environment(location: NetworkLocation, base: NodeJS.ProcessEnv = {}, target: "host" | "container" = location === "build" ? "container" : "host"): Record<string, string> {
    return networkEnvironment(this.settings, location, base, target);
  }
  async dispose(): Promise<void> { await this.dispatcher?.destroy(); }
  toJSON() { return redactNetwork(this.settings); }
}
