import { expect, test } from "vitest";
import { parseRunnerOutput } from "../../src/runtimes/pi/protocol.js";

test.each(["error", "warning"])("runner %s accepts registered codes", type => {
  const output = { schemaVersion: 1, type, code: "SOLVER_OUTPUT_LIMIT", message: "response truncated" };
  expect(parseRunnerOutput(output)).toEqual(output);
});

test.each(["MODEL_OUTPUT_TRUNCATED", "OUTPUT_TOKEN_LIMIT", "ECONNRESET", "RayTaskError", "UNREGISTERED_CODE"])(
  "runner rejects %s as a framework error code", code => {
    for (const type of ["error", "warning"]) {
      expect(() => parseRunnerOutput({ schemaVersion: 1, type, code, message: "failure" }))
        .toThrow("registered error code");
    }
  },
);
