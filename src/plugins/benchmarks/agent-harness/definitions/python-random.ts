/** CPython Random's MT19937 integer-seed, randbelow and sample behavior. */
export class PythonRandom {
  private readonly state = new Uint32Array(624);
  private index = 624;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("Random seed must be a non-negative integer");
    const words: number[] = [];
    let remaining = BigInt(seed);
    do {
      words.push(Number(remaining & 0xffff_ffffn));
      remaining >>= 32n;
    } while (remaining > 0n);
    this.init(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, words.length); k > 0; k--) {
      const prior = this.state[i - 1]!;
      this.state[i] = ((this.state[i]! ^ Math.imul(prior ^ (prior >>> 30), 1664525)) + words[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= 624) {
        this.state[0] = this.state[623]!;
        i = 1;
      }
      if (j >= words.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      const prior = this.state[i - 1]!;
      this.state[i] = ((this.state[i]! ^ Math.imul(prior ^ (prior >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) {
        this.state[0] = this.state[623]!;
        i = 1;
      }
    }
    this.state[0] = 0x80000000;
    this.index = 624;
  }

  private init(seed: number): void {
    this.state[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const prior = this.state[i - 1]!;
      this.state[i] = (Math.imul(1812433253, prior ^ (prior >>> 30)) + i) >>> 0;
    }
  }

  private next(): number {
    if (this.index >= 624) {
      for (let i = 0; i < 624; i++) {
        const value = (this.state[i]! & 0x80000000) | (this.state[(i + 1) % 624]! & 0x7fffffff);
        let next = this.state[(i + 397) % 624]! ^ (value >>> 1);
        if (value & 1) next ^= 0x9908b0df;
        this.state[i] = next >>> 0;
      }
      this.index = 0;
    }
    let value = this.state[this.index++]!;
    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d2c5680;
    value ^= (value << 15) & 0xefc60000;
    value ^= value >>> 18;
    return value >>> 0;
  }

  below(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 0x1_0000_0000)
      throw new TypeError("Invalid random limit");
    const bits = Math.floor(Math.log2(limit)) + 1;
    while (true) {
      const value = this.next() >>> (32 - bits);
      if (value < limit) return value;
    }
  }

  shuffle<T>(values: T[]): void {
    for (let i = values.length - 1; i > 0; i--) {
      const j = this.below(i + 1);
      [values[i], values[j]] = [values[j]!, values[i]!];
    }
  }

  sampleIndices(length: number, count: number): number[] {
    if (!Number.isSafeInteger(length) || !Number.isSafeInteger(count) || length < 0 || count < 0 || count > length)
      throw new RangeError("Sample size must be between zero and the population size");
    const poolLimit = 21 + (count > 5 ? 4 ** Math.ceil(Math.log(count * 3) / Math.log(4)) : 0);
    if (length <= poolLimit) {
      const pool = Array.from({ length }, (_, index) => index);
      const indices: number[] = [];
      for (let index = 0; index < count; index++) {
        const chosen = this.below(length - index);
        indices.push(pool[chosen]!);
        pool[chosen] = pool[length - index - 1]!;
      }
      return indices;
    }
    const seen = new Set<number>();
    const indices: number[] = [];
    while (indices.length < count) {
      const index = this.below(length);
      if (!seen.has(index)) {
        seen.add(index);
        indices.push(index);
      }
    }
    return indices;
  }
}
