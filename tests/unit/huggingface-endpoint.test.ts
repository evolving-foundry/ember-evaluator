import { expect, test } from "vitest";
import { huggingfaceEndpoint } from "../../src/infrastructure/datasets/sources/huggingface/endpoint.js";

test("HF_ENDPOINT replaces the Hugging Face origin", () => {
  expect(huggingfaceEndpoint({})).toBe("https://huggingface.co");
  expect(huggingfaceEndpoint({ HF_ENDPOINT: "https://huggingface.co" })).toBe("https://huggingface.co");
  expect(huggingfaceEndpoint({ HF_ENDPOINT: "https://hf-mirror.com/" })).toBe("https://hf-mirror.com");
  expect(() => huggingfaceEndpoint({ HF_ENDPOINT: "https://user:secret@hf-mirror.com" })).toThrow(/origin/);
});
