import type { TaskRef } from "../contracts/task.js";

/** Fixed Mulberry32 + Fisher-Yates shuffle; do not change the sequence silently,
 * since persisted selections and reproducible comparisons depend on it. */
export function shuffleTasks(tasks: readonly TaskRef[], seed: number): TaskRef[] {
  const shuffled = [...tasks];
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    // Both indexes are in bounds; the candidate list is dense.
    const current = shuffled[index]!;
    shuffled[index] = shuffled[other]!;
    shuffled[other] = current;
  }
  return shuffled;
}
