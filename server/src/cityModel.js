import fs from 'fs';

export function loadCityModel(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const cities = JSON.parse(raw).map(c => ({
    name: c.name,
    lat: c.lat,
    lng: c.lng,
    // ensure presence with sensible defaults
    weight: c.weight ?? 1,
    sigmaKm: c.sigmaKm ?? 5
  }));
  let sum = 0;
  const cum = cities.map((c) => (sum += c.weight));
  return { cities, cumWeights: cum, totalWeight: sum };
}


// Weighted pick + gaussian jitter (Box–Muller)
export function pickCity(model, rand) {
  const r = rand() * model.totalWeight;
  let lo = 0, hi = model.cumWeights.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r <= model.cumWeights[mid]) hi = mid; else lo = mid + 1;
  }
  return model.cities[lo];
}

export function jitterPoint(city, spread, gaussian) {
  const sigmaKm = (city.sigmaKm ?? 10) * spread;
  // very rough: 1km ≈ 0.009 degrees
  const kmToDeg = 0.009;
  const dx = gaussian() * sigmaKm * kmToDeg;
  const dy = gaussian() * sigmaKm * kmToDeg;
  return { lat: city.lat + dy, lng: city.lng + dx };
}
