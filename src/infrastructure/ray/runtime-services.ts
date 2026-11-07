import type { ServiceBinding } from "../../core/contracts/plugin.js";
import { parseModel } from "../../config/effective.js";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../core/validation/input.js";

/** Runtime credentials have one wire shape; no single-model fallback is accepted. */
export function parseRuntimeServices(value: unknown, options: { preparation?: boolean } = {}): Record<string, ServiceBinding> {
  const root = expectRecord(value, "Ray runtime");
  rejectUnknown(root, ["services"], "Ray runtime");
  const services = expectRecord(root.services, "Ray runtime.services");
  if (!Object.keys(services).length) throw new TypeError("Ray runtime requires services");
  return Object.fromEntries(Object.entries(services).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name)) throw new TypeError("Invalid Ray service name");
    const binding = expectRecord(value, "Ray service binding");
    rejectUnknown(binding, ["model", "auth"], "Ray service binding");
    const auth = expectRecord(binding.auth, "Ray service auth");
    rejectUnknown(auth, ["value", "reference"], "Ray service auth");
    if (auth.reference !== null) throw new TypeError("Ray service auth must omit coordinator references");
    const model = expectRecord(binding.model, "Ray service model");
    if (model.apiKey !== undefined || model.apiKeyEnv !== undefined) throw new TypeError("Ray model must not contain credentials");
    const key = options.preparation && auth.value === "" ? "" : expectNonEmptyString(auth.value, "Ray service key");
    return [name, { model: parseModel(model), auth: { value: key, reference: null } }];
  }));
}
