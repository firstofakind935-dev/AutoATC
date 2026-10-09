// Aircraft the planner knows: every PTFS type that flies a route, keyed by
// ICAO code (same codes as 365Radar's AcftTypeMap.js), with which FMS style
// the companion app shows for it and rough performance for planning.
//
// Performance is per category, not per type - good enough for a game
// briefing, not real dispatch figures. Speeds are knots, rates feet per
// minute, fuel burn kg per hour.

const CATEGORIES = {
  widebody: { cruiseKt: 480, climbKt: 300, approachKt: 150, ceilingFt: 41000, climbFpm: 2200, descentFpm: 2000, burnKgHr: 7000, taxiKg: 250 },
  narrowbody: { cruiseKt: 450, climbKt: 280, approachKt: 140, ceilingFt: 39000, climbFpm: 2500, descentFpm: 2000, burnKgHr: 2600, taxiKg: 150 },
  regionaljet: { cruiseKt: 430, climbKt: 270, approachKt: 135, ceilingFt: 37000, climbFpm: 2800, descentFpm: 2000, burnKgHr: 1800, taxiKg: 100 },
  turboprop: { cruiseKt: 300, climbKt: 200, approachKt: 120, ceilingFt: 25000, climbFpm: 1800, descentFpm: 1500, burnKgHr: 700, taxiKg: 40 },
  bizjet: { cruiseKt: 440, climbKt: 280, approachKt: 125, ceilingFt: 45000, climbFpm: 3500, descentFpm: 2500, burnKgHr: 800, taxiKg: 40 },
  military: { cruiseKt: 330, climbKt: 250, approachKt: 130, ceilingFt: 30000, climbFpm: 1800, descentFpm: 1500, burnKgHr: 3000, taxiKg: 100 },
  fighter: { cruiseKt: 520, climbKt: 350, approachKt: 150, ceilingFt: 50000, climbFpm: 10000, descentFpm: 4000, burnKgHr: 3500, taxiKg: 100 },
  supersonic: { cruiseKt: 1100, climbKt: 400, approachKt: 160, ceilingFt: 60000, climbFpm: 5000, descentFpm: 3500, burnKgHr: 20000, taxiKg: 400 },
  light: { cruiseKt: 120, climbKt: 80, approachKt: 65, ceilingFt: 12000, climbFpm: 700, descentFpm: 600, burnKgHr: 35, taxiKg: 5 },
  helicopter: { cruiseKt: 120, climbKt: 90, approachKt: 60, ceilingFt: 8000, climbFpm: 800, descentFpm: 800, burnKgHr: 300, taxiKg: 10 },
};

// [icao, name, category, fms]. fms picks the companion's MCDU/CDU style:
// airbus, a350 (A350/A380), a220, boeing, boeing787 or embraer, or generic - the neutral Default
// FMS for every aircraft without a manufacturer style of its own. A pilot
// can still switch in the FMS window.
const TYPES = [
  ['A320', 'Airbus A320', 'narrowbody', 'airbus'],
  ['A332', 'A330 MRTT', 'widebody', 'airbus'],
  ['A333', 'Airbus A330', 'widebody', 'airbus'],
  ['A343', 'Airbus A340', 'widebody', 'airbus'],
  ['A359', 'Airbus A350', 'widebody', 'a350'],
  ['A388', 'Airbus A380', 'widebody', 'a350'],
  ['A3ST', 'Airbus Beluga', 'widebody', 'airbus'],
  ['BCS1', 'Airbus A220', 'regionaljet', 'a220'],
  ['B703', 'Boeing 707', 'widebody', 'boeing'],
  ['B722', 'Boeing 727', 'narrowbody', 'boeing'],
  ['B737', 'C40', 'narrowbody', 'boeing'],
  ['B738', 'Boeing 737', 'narrowbody', 'boeing'],
  ['B742', '747AF1', 'widebody', 'boeing'],
  ['B744', 'Boeing 747', 'widebody', 'boeing'],
  ['B752', 'Boeing 757', 'narrowbody', 'boeing'],
  ['B762', 'KC767', 'widebody', 'boeing'],
  ['B763', 'Boeing 767', 'widebody', 'boeing'],
  ['B77L', 'Boeing 777 Cargo', 'widebody', 'boeing'],
  ['B77W', 'Boeing 777', 'widebody', 'boeing'],
  ['B789', 'Boeing 787', 'widebody', 'boeing787'],
  ['BLCF', 'DreamLifter', 'widebody', 'boeing'],
  ['P8', 'P8', 'narrowbody', 'boeing'],
  ['MD11', 'Douglas MD11', 'widebody', 'boeing'],
  ['MD90', 'Douglas MD90', 'narrowbody', 'boeing'],
  ['L101', 'Lockheed Tristar', 'widebody', 'generic'],
  ['CRJ7', 'Bombardier CRJ700', 'regionaljet', 'generic'],
  ['DH8D', 'Bombardier Q400', 'turboprop', 'generic'],
  ['LJ45', 'Bombardier Learjet 45', 'bizjet', 'generic'],
  ['E190', 'E190', 'regionaljet', 'embraer'],
  ['AT76', 'ATR72', 'turboprop', 'generic'],
  ['A225', 'An 225', 'widebody', 'generic'],
  ['AN22', 'An22', 'military', 'generic'],
  ['C130', 'C130 Hercules', 'military', 'generic'],
  ['C30J', 'KC130J', 'military', 'generic'],
  ['C17', 'C17', 'military', 'generic'],
  ['E3TF', 'E-3 Sentry', 'widebody', 'boeing'],
  ['CONC', 'Concorde', 'supersonic', 'generic'],
  ['SF50', 'Cirrus Vision', 'bizjet', 'generic'],
  ['BE20', 'KingAir 260', 'turboprop', 'generic'],
  ['C208', 'Cessna Caravan', 'turboprop', 'generic'],
  ['DHC6', 'DHC-6 Twin Otter', 'turboprop', 'generic'],
  ['C402', 'Cessna 402', 'light', 'generic'],
  ['C172', 'Cessna 172', 'light', 'generic'],
  ['C182', 'Cessna 182', 'light', 'generic'],
  ['P28A', 'Piper PA28181', 'light', 'generic'],
  ['J3', 'Piper Cub', 'light', 'generic'],
  ['F16', 'F16', 'fighter', 'generic'],
  ['F18S', 'F/A-18 Super Hornet', 'fighter', 'generic'],
  ['F22', 'F22', 'fighter', 'generic'],
  ['F35', 'F35', 'fighter', 'generic'],
  ['EUFI', 'Eurofighter Typhoon', 'fighter', 'generic'],
  ['H60', 'UH-60', 'helicopter', 'generic'],
  ['S92', 'Sikorsky S92', 'helicopter', 'generic'],
  ['B412', 'Bell 412', 'helicopter', 'generic'],
];

const AIRCRAFT = TYPES.map(([icao, name, category, fms]) => ({ icao, name, category, fms, ...CATEGORIES[category] }));
const byIcao = new Map(AIRCRAFT.map((a) => [a.icao, a]));

function findAircraft(icao) {
  return byIcao.get(String(icao || '').toUpperCase()) || null;
}

module.exports = { AIRCRAFT, findAircraft };
