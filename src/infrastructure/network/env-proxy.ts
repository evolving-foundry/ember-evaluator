import { Agent, EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";

function proxyEnvPresent(): boolean {
  return Boolean(
    process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy,
  );
}

/**
 * Install one fetch/dispatcher policy for evaluator downloads and pi model
 * calls, including direct connections. HTTP/2 is opt-in because large proxied
 * downloads can terminate mid-stream on that protocol path.
 */
export function installEnvProxy(): void {
  const options = { allowH2: process.env.EVALUATOR_HTTP2 === "1" };
  setGlobalDispatcher(proxyEnvPresent() ? new EnvHttpProxyAgent(options) : new Agent(options));
  install();
}
