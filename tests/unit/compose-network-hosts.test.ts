import { expect, test } from "vitest";
import { relocateSharedNetworkHosts } from "../../src/infrastructure/containers/compose.js";
import type { JsonValue } from "../../src/core/contracts/task.js";

test("shared-network tasks inherit gateway and explicit mappings from their ultimate network owner", () => {
  const services: Record<string, Record<string, JsonValue>> = {
    main: { network_mode: "service:proxy", extra_hosts: { "host.docker.internal": "host-gateway", custom: "127.0.0.2" } },
    proxy: { network_mode: "service:api", extra_hosts: ["other:127.0.0.3"] }, api: {},
  };
  relocateSharedNetworkHosts(services);
  expect(services.main).not.toHaveProperty("extra_hosts");
  expect(services.proxy).not.toHaveProperty("extra_hosts");
  expect(services.api?.extra_hosts).toEqual({ "host.docker.internal": "host-gateway", custom: "127.0.0.2", other: "127.0.0.3" });
});

test("conflicting mappings and network namespace cycles fail before Docker creation", () => {
  expect(() => relocateSharedNetworkHosts({ main: { network_mode: "service:api", extra_hosts: { custom: "127.0.0.1" } },
    api: { extra_hosts: { custom: "127.0.0.2" } } })).toThrow(/Conflicting/);
  expect(() => relocateSharedNetworkHosts({ main: { network_mode: "service:api" }, api: { network_mode: "service:main" } })).toThrow(/cycle/);
});
