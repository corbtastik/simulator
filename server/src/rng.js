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

// Given desired median (m) and p95, compute mu/sigma for log-normal, then sample
export function sampleLogNormal(rand, { medianSec, p95Sec }) {
  const m = medianSec;
  const p95 = p95Sec;
  // log-normal relationships:
  // median = exp(mu), p95 = exp(mu + 1.64485*sigma)
  const mu = Math.log(m);
  const sigma = (Math.log(p95) - mu) / 1.64485;
  // Box–Muller for standard normal using our seeded rand()
  const u1 = Math.max(rand(), Number.EPSILON);
  const u2 = Math.max(rand(), Number.EPSILON);
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ln = Math.exp(mu + sigma * z);
  return Math.max(1, Math.round(ln)); // seconds, at least 1s
}

