// Deterministic RNG + gaussian if seed provided
export function makeRNG(seed) {
  if (seed == null) {
    return { rand: Math.random, gaussian: boxMuller(Math.random) };
  }
  let s = Number(seed) >>> 0;
  const rand = () => {
    // xorshift32
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 0xffffffff);
  };
  return { rand, gaussian: boxMuller(rand) };
}

function boxMuller(rand) {
  let spare = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0, r = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      r = u*u + v*v;
    } while (r === 0 || r >= 1);
    const mul = Math.sqrt(-2.0 * Math.log(r) / r);
    spare = v * mul;
    return u * mul;
  };
}
