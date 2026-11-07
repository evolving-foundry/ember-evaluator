/** Feedback payload shape shared by the collector and the web view. */
export const SCHEMA_VERSION = "OptFeedback";

export interface CandidateHint {
  candidate_id?: string;
  parent_id?: string;
  fingerprint?: string | object;
}

export interface Feedback {
  schema_version: string;
  epoch: number | string;
  candidate: { candidate_id?: string; parent_id?: string; fingerprint: unknown };
  population: unknown;
  signals: unknown[];
  delta_vs_parent: unknown;
  explain: unknown;
}

export function makeFeedback(
  epoch: number | string,
  candidate: CandidateHint | null = null,
  population: unknown = null,
  signals: unknown[] | null = null,
  delta: unknown = null,
  explain: unknown = null,
): Feedback {
  const hint = { ...(candidate ?? {}) };
  let fingerprint: unknown = hint.fingerprint;
  if (typeof fingerprint === "string") {
    try {
      fingerprint = JSON.parse(fingerprint);
    } catch {
      // Keep the raw string when it is not valid JSON.
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    epoch,
    candidate: {
      ...(hint.candidate_id === undefined ? {} : { candidate_id: hint.candidate_id }),
      ...(hint.parent_id === undefined ? {} : { parent_id: hint.parent_id }),
      fingerprint: fingerprint || {},
    },
    population: population || {},
    signals: signals || [],
    delta_vs_parent: delta,
    explain,
  };
}
