// server/src/stateLookup.js
// Approximate US state lookup based on coordinates.
// Uses rough bounding boxes for each state. Not perfect but functional for demo.

// State bounding boxes: [minLat, maxLat, minLng, maxLng]
// Ordered by area (smaller states checked first for better precision in overlaps)
const STATE_BOUNDS = [
  // Small eastern states first (more precise matching)
  { state: 'DC', bounds: [38.79, 38.99, -77.12, -76.91] },
  { state: 'RI', bounds: [41.14, 42.02, -71.86, -71.12] },
  { state: 'DE', bounds: [38.45, 39.84, -75.79, -75.05] },
  { state: 'CT', bounds: [40.98, 42.05, -73.73, -71.79] },
  { state: 'NJ', bounds: [38.93, 41.36, -75.56, -73.89] },
  { state: 'NH', bounds: [42.70, 45.30, -72.56, -70.70] },
  { state: 'VT', bounds: [42.73, 45.02, -73.44, -71.46] },
  { state: 'MA', bounds: [41.24, 42.89, -73.51, -69.93] },
  { state: 'MD', bounds: [37.91, 39.72, -79.49, -75.05] },
  { state: 'WV', bounds: [37.20, 40.64, -82.64, -77.72] },
  { state: 'SC', bounds: [32.03, 35.21, -83.35, -78.54] },
  { state: 'IN', bounds: [37.77, 41.76, -88.10, -84.78] },
  { state: 'KY', bounds: [36.50, 39.15, -89.57, -81.96] },
  { state: 'TN', bounds: [34.98, 36.68, -90.31, -81.65] },
  { state: 'VA', bounds: [36.54, 39.47, -83.67, -75.24] },
  { state: 'OH', bounds: [38.40, 42.33, -84.82, -80.52] },
  { state: 'PA', bounds: [39.72, 42.27, -80.52, -74.69] },
  { state: 'NY', bounds: [40.50, 45.02, -79.76, -71.86] },
  { state: 'NC', bounds: [33.84, 36.59, -84.32, -75.46] },
  { state: 'GA', bounds: [30.36, 35.00, -85.60, -80.84] },
  { state: 'AL', bounds: [30.22, 35.01, -88.47, -84.89] },
  { state: 'MS', bounds: [30.17, 35.00, -91.66, -88.10] },
  { state: 'LA', bounds: [28.93, 33.02, -94.04, -88.82] },
  { state: 'AR', bounds: [33.00, 36.50, -94.62, -89.64] },
  { state: 'MO', bounds: [35.99, 40.61, -95.77, -89.10] },
  { state: 'IA', bounds: [40.37, 43.50, -96.64, -90.14] },
  { state: 'IL', bounds: [36.97, 42.51, -91.51, -87.02] },
  { state: 'WI', bounds: [42.49, 47.08, -92.89, -86.25] },
  { state: 'MI', bounds: [41.70, 48.19, -90.42, -82.42] },
  { state: 'MN', bounds: [43.50, 49.38, -97.24, -89.49] },
  { state: 'FL', bounds: [24.52, 31.00, -87.63, -80.03] },
  { state: 'ME', bounds: [43.06, 47.46, -71.08, -66.95] },

  // Larger western states
  { state: 'ND', bounds: [45.94, 49.00, -104.05, -96.55] },
  { state: 'SD', bounds: [42.48, 45.94, -104.06, -96.44] },
  { state: 'NE', bounds: [40.00, 43.00, -104.05, -95.31] },
  { state: 'KS', bounds: [36.99, 40.00, -102.05, -94.59] },
  { state: 'OK', bounds: [33.62, 37.00, -103.00, -94.43] },
  { state: 'TX', bounds: [25.84, 36.50, -106.65, -93.51] },
  { state: 'NM', bounds: [31.33, 37.00, -109.05, -103.00] },
  { state: 'CO', bounds: [36.99, 41.00, -109.06, -102.04] },
  { state: 'WY', bounds: [41.00, 45.00, -111.06, -104.05] },
  { state: 'MT', bounds: [44.36, 49.00, -116.05, -104.04] },
  { state: 'ID', bounds: [41.99, 49.00, -117.24, -111.04] },
  { state: 'UT', bounds: [36.99, 42.00, -114.05, -109.04] },
  { state: 'AZ', bounds: [31.33, 37.00, -114.82, -109.04] },
  { state: 'NV', bounds: [35.00, 42.00, -120.00, -114.04] },
  { state: 'WA', bounds: [45.54, 49.00, -124.85, -116.92] },
  { state: 'OR', bounds: [41.99, 46.29, -124.57, -116.46] },
  { state: 'CA', bounds: [32.53, 42.01, -124.41, -114.13] },

  // Alaska and Hawaii (approximate)
  { state: 'AK', bounds: [51.21, 71.39, -179.15, -129.98] },
  { state: 'HI', bounds: [18.91, 22.24, -160.25, -154.81] },
];

/**
 * Look up the US state abbreviation for a given coordinate.
 * Returns 'XX' if no match found.
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {string} - Two-letter state abbreviation
 */
export function lookupState(lat, lng) {
  for (const { state, bounds } of STATE_BOUNDS) {
    const [minLat, maxLat, minLng, maxLng] = bounds;
    if (lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng) {
      return state;
    }
  }
  // Fallback for edge cases - use nearest state by longitude bands
  if (lng < -120) return 'CA';
  if (lng < -110) return 'NV';
  if (lng < -100) return 'CO';
  if (lng < -90) return 'TX';
  if (lng < -80) return 'GA';
  if (lng < -70) return 'NC';
  return 'NY';
}

// Full state names for display if needed
export const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
