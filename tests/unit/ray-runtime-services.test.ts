import { expect, test } from "vitest";
import { parseRuntimeServices } from "../../src/infrastructure/ray/runtime-services.js";

const model = { name: "solver", endpoint: "https://model.invalid/v1", api: "openai-completions", provider: null };
const auth = { value: "solver-key", reference: null };
const services = { solver: { model, auth }, judge: { model: { ...model, name: "judge" }, auth: { ...auth, value: "judge-key" } } };

test("worker runtime uses one service table and keeps solver and judge credentials distinct", () => {
  expect(parseRuntimeServices({ services })).toEqual(services);
});

test("only preparation workers accept model metadata without credentials", () => {
  const input = { services: { solver: { model, auth: { value: "", reference: null } } } };
  expect(parseRuntimeServices(input, { preparation: true }).solver?.auth.value).toBe("");
  expect(() => parseRuntimeServices(input)).toThrow();
});

test.each([
  { model, auth }, { services, model, auth }, { services: {} },
  { services: { solver: { model, auth: { ...auth, reference: "COORDINATOR_KEY" } } } },
  { services: { solver: { model: { ...model, apiKey: "private" }, auth } } },
])("worker rejects old or malformed runtime service input", input => {
  expect(() => parseRuntimeServices(input)).toThrow();
});
