/** Numeric helpers that keep the collector's rounding predictable. */

/** Rounds to a number of decimal digits using half-away-from-zero. */
export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
