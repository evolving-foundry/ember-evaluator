import { Agent, EnvHttpProxyAgent, Pool } from "undici";
import type { NetworkProxy } from "../../core/contracts/network.js";

/** A null HTTPS route means direct, even if HTTP has a proxy; Undici's default fallback differs. */
export function createNetworkDispatcher(proxy: NetworkProxy): Agent {
  const allowH2 = process.env.EVALUATOR_HTTP2 === "1";
  return new Agent({ allowH2, factory(origin, options) {
    const route = new URL(origin).protocol === "https:" ? proxy.https : proxy.http;
    return route
      ? new EnvHttpProxyAgent({ allowH2, httpProxy: route, httpsProxy: route, noProxy: proxy.noProxy.join(",") })
      : new Pool(origin, options);
  } });
}
