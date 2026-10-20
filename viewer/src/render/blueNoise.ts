// Void-and-cluster blue noise (Ulichney 1993), generated at startup so no texture asset is shipped.
// Deterministic for a given seed (export frames must be reproducible).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function blueNoise(size = 64, seed = 1, sigma = 1.5): { ranks: Uint16Array; bytes: Uint8Array } {
  const n = size * size;
  const kernel = new Float32Array(n);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - x);
      const dy = Math.min(y, size - y);
      kernel[y * size + x] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  const energy = new Float32Array(n);
  const on = new Uint8Array(n);
  const toggle = (i: number, sign: number) => {
    const ix = i % size;
    const iy = (i / size) | 0;
    for (let y = 0; y < size; y++) {
      const ky = (y - iy + size) % size;
      for (let x = 0; x < size; x++) energy[y * size + x] += sign * kernel[ky * size + ((x - ix + size) % size)];
    }
  };
  const extreme = (wantOn: number, max: boolean) => {
    let best = -1;
    let bv = max ? -Infinity : Infinity;
    for (let i = 0; i < n; i++) {
      if (on[i] !== wantOn) continue;
      const e = energy[i];
      if (max ? e > bv : e < bv) {
        bv = e;
        best = i;
      }
    }
    return best;
  };

  const rnd = mulberry32(seed);
  const initial = Math.max(1, Math.round(n * 0.1));
  for (let k = 0; k < initial; ) {
    const i = Math.floor(rnd() * n);
    if (!on[i]) {
      on[i] = 1;
      toggle(i, 1);
      k++;
    }
  }
  // relax: move the tightest cluster into the largest void until stable
  for (let iter = 0; iter < n; iter++) {
    const c = extreme(1, true);
    on[c] = 0;
    toggle(c, -1);
    const v = extreme(0, false);
    on[v] = 1;
    toggle(v, 1);
    if (v === c) break;
  }
  const ranks = new Uint16Array(n);
  const proto = on.slice();
  const protoEnergy = energy.slice();
  // phase 1: rank the initial points by removing tightest clusters
  let count = initial;
  while (count > 0) {
    const c = extreme(1, true);
    on[c] = 0;
    toggle(c, -1);
    count--;
    ranks[c] = count;
  }
  on.set(proto);
  energy.set(protoEnergy);
  // phase 2+3: fill the largest voids
  for (let r = initial; r < n; r++) {
    const v = extreme(0, false);
    on[v] = 1;
    toggle(v, 1);
    ranks[v] = r;
  }
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = Math.floor((ranks[i] * 256) / n);
  return { ranks, bytes };
}
