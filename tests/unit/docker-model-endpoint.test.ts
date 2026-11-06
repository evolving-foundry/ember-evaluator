import { describe, expect, it } from "vitest";
import { dockerHostModelEndpoint } from "../../src/infrastructure/network/model-gateway.js";

describe("Docker host model endpoints", () => {
  it.each(["127.0.0.1", "localhost", "[::1]"])("maps host loopback %s while retaining the API path and port", host => {
    expect(dockerHostModelEndpoint(`http://${host}:4000/v1`)).toBe("http://host.docker.internal:4000/v1");
  });

  it.each(["https://models.example/v1", "http://192.168.1.2:4000/v1", "http://host.docker.internal:4000/v1"])(
    "preserves externally reachable endpoints: %s", endpoint => {
      expect(dockerHostModelEndpoint(endpoint)).toBe(endpoint);
    },
  );
});
