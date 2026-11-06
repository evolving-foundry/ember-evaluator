import { localDatasetConfig } from "../../../shared/local-data.js";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";

export const OFFICEQA_DATASET_REVISION = "65a2b315780417bc50d7bfe6e5bdb904e63fda65";
/** Official parsed documents or original PDFs; neither denotes an image-only protocol. */
export type OfficeQAProV2DocumentFormat = "parsed-json" | "pdf";

export type OfficeQAProV2Config = {
  /** parsed-json is searchable text/tables; pdf preserves original bytes and allows text extraction. */
  corpusFormat: OfficeQAProV2DocumentFormat;
  revision: string;
  cacheDir: string;
  hfToken?: string;
  localPath?: string;
  dockerExecutable: string;
  tolerance: number;
};

export function parseOfficeQAProV2Config(value: unknown): OfficeQAProV2Config {
  const config = expectRecord(value, "officeqa-pro-v2");
  rejectUnknown(config, ["corpusFormat", "revision", "cacheDir", "localPath", "hfToken", "dockerExecutable", "tolerance"], "officeqa-pro-v2");
  const corpusFormat = config.corpusFormat ?? "parsed-json";
  if (corpusFormat !== "parsed-json" && corpusFormat !== "pdf") throw new TypeError("officeqa-pro-v2.corpusFormat must be parsed-json or pdf");
  const revision = expectNonEmptyString(config.revision ?? OFFICEQA_DATASET_REVISION, "officeqa-pro-v2.revision");
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new TypeError("officeqa-pro-v2.revision must be a full commit SHA");
  const tolerance = config.tolerance ?? 0;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1)
    throw new TypeError("officeqa-pro-v2.tolerance must be between 0 and 1");
  return { corpusFormat, revision, tolerance, ...localDatasetConfig(config),
    ...(config.hfToken === undefined ? {} : { hfToken: expectNonEmptyString(config.hfToken, "officeqa-pro-v2.hfToken") }),
    cacheDir: expectNonEmptyString(config.cacheDir ?? ".cache/officeqa-pro-v2", "officeqa-pro-v2.cacheDir"),
    dockerExecutable: expectNonEmptyString(config.dockerExecutable ?? "docker", "officeqa-pro-v2.dockerExecutable") };
}
