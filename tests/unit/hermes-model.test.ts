import { expect, test } from "vitest";
import { parse } from "yaml";
import { HERMES_AUTH_ENV, hermesModelSettings } from "../../src/runtimes/hermes/model.js";

test("maps the shared model to a custom endpoint alias with its own key env", () => {
  const value = parse(hermesModelSettings({ name: "office-mock-model", endpoint: "http://localhost:18080/v1", api: "openai-completions", provider: null }));
  expect(value.model_aliases["office-mock-model"]).toEqual({
    model: "office-mock-model", provider: "custom", base_url: "http://localhost:18080/v1", key_env: HERMES_AUTH_ENV,
  });
});

test("requires an explicit endpoint: hermes aliases cannot ride a catalog default", () => {
  const model = { name: "model", endpoint: null, api: null, provider: "openai" };
  expect(() => hermesModelSettings(model)).toThrow(/endpoint/i);
});

test("does not persist endpoint credentials into the alias", () => {
  expect(() => hermesModelSettings({ name: "model", endpoint: "https://user:secret@example.com/v1", api: "openai-completions", provider: null })).toThrow(/credentials/i);
  expect(() => hermesModelSettings({ name: "model", endpoint: "https://example.com/v1?api_key=leak", api: "openai-completions", provider: null })).toThrow(/credentials/i);
});
