// server/src/serviceIssues.js
// Random AT&T-flavored serviceIssue generator, keyed by city name.
import { faker } from '@faker-js/faker';

// --- helpers ---------------------------------------------------------

function pick(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }

function codeFromCity(city, rand) {
  const rdigit = () => Math.floor(rand() * 10);
  if (typeof city === 'string' && city.trim().length) {
    const letters = city.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (letters.length >= 3) return letters.slice(0, 3);
    if (letters.length === 2) return letters + rdigit();
    if (letters.length === 1) return letters + rdigit() + rdigit();
  }
  // fallback: random 3 letters (A–Z)
  const A = 65;
  return String.fromCharCode(A + Math.floor(rand() * 26))
       + String.fromCharCode(A + Math.floor(rand() * 26))
       + String.fromCharCode(A + Math.floor(rand() * 26));
}

// Safer IPv4 generator (consistent across faker versions/locales)
function ip4(rand) {
  const oct = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  return `${oct(1,223)}.${oct(0,255)}.${oct(0,255)}.${oct(1,254)}`;
}

// --- main ------------------------------------------------------------

/**
 * Create a random serviceIssue object.
 * @param {Function} rand - PRNG returning [0,1)
 * @param {string} city  - City name for code derivation
 */
export function makeServiceIssue(rand, city) {
  const code = codeFromCity(city, rand);

  const types = [
    'broadband','wireless','fiber','5g','smartcell','wifi-hotspot','enterprise',
    'iot','satellite','firstnet','voip','b2b','construction',
    'backhaul','datacenter','edge','public-safety','smart-city',
    'government','cloud-network'
  ];
  const t = pick(types, rand);

  switch (t) {
    case 'broadband': return {
      type: 'broadband',
      category: 'consumer',
      accountId: `ATTB-${faker.number.int({ min:100, max:999 })}`,
      issue: pick(['slow-speeds','packet-loss','intermittent'], rand),
      downstreamMbps: Number((rand()*50 + 1).toFixed(1)),
      expectedMbps: pick([50,100,300,500,1000], rand)
    };

    case 'wireless': return {
      type: 'wireless',
      category: 'consumer',
      phone: faker.phone.number('+1-###-555-0###'),
      issue: pick(['no-signal','dropped-calls','throttling'], rand),
      towerId: `${code}-TWR-${faker.number.int({ min:100, max:999 })}`,
      deviceModel: pick(['iPhone 15 Pro','Galaxy S24','Pixel 9 Pro'], rand)
    };

    case 'fiber': return {
      type: 'fiber',
      category: 'consumer',
      accountId: `ATTF-${faker.number.int({ min:10, max:999 })}`,
      issue: pick(['outage','install-delay','light-level-low'], rand),
      outageStart: new Date(Date.now() - faker.number.int({ min: 5, max: 120 })*60*1000).toISOString(),
      region: `${faker.location.city()}, ${faker.location.state({ abbreviated:true })}`
    };

    case '5g': return {
      type: '5g',
      category: 'consumer',
      imei: faker.number.int({ min: 3.5e14, max: 3.6e14 }).toString(),
      issue: pick(['handover-failure','nr-drop','sa-fallback'], rand),
      cellSector: pick(['Sector-A','Sector-B','Sector-C'], rand),
      towerId: `${code}-5G-${faker.number.int({ min:50, max:999 })}`
    };

    case 'smartcell': return {
      type: 'smartcell',
      category: 'infrastructure',
      nodeId: `SC-${code}-${faker.number.int({ min:100, max:999 })}`,
      issue: pick(['power-loss','backhaul-down','gps-sync-lost'], rand),
      lastHeartbeat: new Date(Date.now() - faker.number.int({ min: 1, max: 90 })*60*1000).toISOString()
    };

    case 'wifi-hotspot': return {
      type: 'wifi-hotspot',
      category: 'consumer',
      ssid: `attwifi-${(city || faker.location.city()).toUpperCase().replace(/\s/g,'')}`,
      issue: pick(['authentication-failure','captive-portal-loop','no-dhcp'], rand),
      macAddress: faker.internet.mac()
    };

    case 'enterprise': return {
      type: 'enterprise',
      category: 'business',
      customer: pick(['J.P. Morgan','AT&T Business','Boeing','GM','Amex'], rand),
      slaTier: pick(['gold','platinum'], rand),
      issue: pick(['latency-spike','throughput-drop'], rand),
      latencyMs: faker.number.int({ min: 120, max: 500 })
    };

    case 'iot': return {
      type: 'iot',
      category: 'emerging_tech',
      deviceId: `SIM-${faker.number.int({ min: 10000000, max: 99999999 })}`,
      issue: pick(['no-uplink','sleep-storm','firmware-crash'], rand),
      fleet: pick(['FedEx Fleet Sensors','UPS Trailer Telematics','USPS Pallets', 'Fiber Attenuator'], rand),
      region: pick(['North','North-East','East','South-East', 'South', 'South-West', 'West', 'North-West'], rand)
    };

    case 'satellite': return {
      type: 'satellite',
      category: 'emerging_tech',
      terminalId: `SAT-${faker.number.int({ min:1000, max:9999 })}`,
      issue: pick(['signal-degradation','rain-fade'], rand),
      snrDb: Number((6 + rand()*6).toFixed(1))
    };

    case 'firstnet': return {
      type: 'firstnet',
      category: 'federal',
      agency: pick(['Dallas Fire Department','Plano PD','Austin EMS'], rand),
      issue: pick(['coverage-gap','priority-preemption'], rand)
    };

    case 'voip': return {
      type: 'voip',
      category: 'business',
      accountId: `ATT-VOIP-${faker.number.int({ min:100, max:999 })}`,
      issue: pick(['call-jitter','one-way-audio'], rand),
      jitterMs: faker.number.int({ min: 60, max: 180 })
    };

    case 'b2b': return {
      type: 'b2b',
      category: 'business',
      customer: pick(['Lockheed Martin','Raytheon','Bank of America'], rand),
      issue: pick(['packet-loss','tunnel-down','ike-rekey-loop'], rand),
      lossPercent: Number((rand()*5).toFixed(1)),
      tunnelId: `VPN-${code}-${faker.number.int({ min: 1, max: 999 }).toString().padStart(3,'0')}`
    };

    case 'construction': return {
      type: 'construction',
      category: 'infrastructure',      
      projectCode: `FBR-${code}-${faker.number.int({ min:100, max:999 })}`,
      crewCode: `CRW-${faker.number.int({ min:1000, max:9999 })}`,
      issue: pick(['permit-delay','locate-required','splice-crew-shortage'], rand),
      expectedCompletion: new Date(Date.now() + faker.number.int({ min: 1, max: 14 })*24*60*60*1000).toISOString(),
      contractor: pick(['Lumen Builders','Hedgehog Fiber','Apex Utilities'], rand)
    };

    case 'backhaul': return {
      type: 'backhaul',
      category: 'infrastructure',
      linkCode: `BH-${code}-${faker.number.int({ min:100, max:999 })}`,
      issue: pick(['capacity-exceeded','fiber-flap','los-increase'], rand),
      utilizationPct: Number((90 + rand()*10).toFixed(1))
    };

    case 'datacenter': return {
      type: 'datacenter',
      category: 'infrastructure',
      facilityCode: `ATT${code}0${faker.number.int({ min:1, max:9 })}`,
      issue: pick(['cooling-alert','power-a-feed'], rand),
      temperatureC: Number((30 + rand()*12).toFixed(1))
    };

    case 'edge': return {
      type: 'edge',
      category: 'infrastructure',
      nodeId: `EDGE-${code}-${faker.number.int({ min:1, max:999 }).toString().padStart(3,'0')}`,
      issue: pick(['cpu-overload','pod-crashloop','registry-throttle'], rand),
      cpuUtilization: faker.number.int({ min: 85, max: 99 })
    };

    case 'public-safety': return {
      type: 'public-safety',
      category: 'federal',
      agency: pick(['Plano PD','Dallas Sheriff','Austin Fire'], rand),
      issue: pick(['dispatch-app-error','mdt-offline'], rand),
      incidentCode: `INC-${new Date().getFullYear()}-${faker.number.int({ min:1000, max:9999 })}`
    };

    case 'smart-city': return {
      type: 'smart-city',
      category: 'emerging_tech',
      sensorId: `CAM-${code}-${faker.number.int({ min:100, max:999 })}`,
      issue: pick(['connectivity-loss','lens-obstructed'], rand),
      location: `${faker.location.street()}`
    };

    case 'government': return {
      type: 'government',
      category: 'federal',
      department: pick(['FAA Communications','USPS Ops','DOT SW Region'], rand),
      issue: pick(['redundancy-failover','circuit-flap'], rand),
      region: pick(['Southwest Ops','Central Ops','Northeast Ops'], rand)
    };

    case 'cloud-network': return {
      type: 'cloud-network',
      category: 'infrastructure',
      customer: pick(['AWS Direct Connect','Azure ExpressRoute','GCP Interconnect'], rand),
      issue: pick(['route-flap','bgp-session-reset'], rand),
      bgpPeer: ip4(rand)
    };

    default: return { type: 'unknown', issue: 'unspecified' };
  }
}
