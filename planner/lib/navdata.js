// Loads planner/data/navdata.json (built by scripts/build-navdata.js) and
// indexes it for lookups by identifier.

const navdata = require('../data/navdata.json');

const airports = navdata.airports.map((a) => ({ ...a, type: 'APT', ident: a.icao }));
const fixes = navdata.fixes;
const airportByIcao = new Map(airports.map((a) => [a.icao, a]));
const fixByIdent = new Map(fixes.map((f) => [f.ident, f]));

const findAirport = (icao) => airportByIcao.get(String(icao || '').toUpperCase()) || null;
const findFix = (ident) => fixByIdent.get(String(ident || '').toUpperCase()) || null;

module.exports = { navdata, airports, fixes, findAirport, findFix };
