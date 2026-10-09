// Route finding between two airports through the named waypoints/VORs.
//
// There are no airways, SIDs or STARs in PTFS's data, so a route is the
// shortest chain of fixes where no single leg is longer than MAX_LEG_NM -
// short enough that the route actually follows waypoints, like a real
// flight plan, instead of one direct line. Each extra leg costs
// LEG_PENALTY_NM so the search doesn't zigzag through every nearby fix to
// shave a tenth of a mile.

const { distanceNm } = require('./geo');
const { fixes, findFix } = require('./navdata');

const MAX_LEG_NM = 9;
const LEG_PENALTY_NM = 1.5;

/** Finds a fix-to-fix route. Returns the intermediate fixes (may be empty). */
function findRoute(origin, destination) {
  const nodes = [origin, ...fixes, destination];
  const goal = nodes.length - 1;
  const best = new Array(nodes.length).fill(Infinity);
  const cameFrom = new Array(nodes.length).fill(-1);
  const done = new Array(nodes.length).fill(false);
  best[0] = 0;

  // Dijkstra with an A* distance-to-go heuristic; ~150 nodes, so a linear
  // scan for the next node is plenty fast.
  for (;;) {
    let current = -1;
    let currentScore = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (done[i] || best[i] === Infinity) continue;
      const score = best[i] + distanceNm(nodes[i], destination);
      if (score < currentScore) {
        current = i;
        currentScore = score;
      }
    }
    if (current === -1) break;
    if (current === goal) break;
    done[current] = true;

    for (let next = 1; next < nodes.length; next++) {
      if (done[next]) continue;
      const leg = distanceNm(nodes[current], nodes[next]);
      if (leg > MAX_LEG_NM) continue;
      const cost = best[current] + leg + LEG_PENALTY_NM;
      if (cost < best[next]) {
        best[next] = cost;
        cameFrom[next] = current;
      }
    }
  }

  // Islands too far apart for the fix network (or no fixes nearby) - fly
  // direct rather than fail.
  if (cameFrom[goal] === -1) return [];

  const path = [];
  for (let i = cameFrom[goal]; i > 0; i = cameFrom[i]) path.unshift(nodes[i]);
  return path;
}

/**
 * Parses a pilot-typed route ("DCT SHELL NIKON DCT CHILY") into fixes.
 * Throws with every unknown identifier listed, so the form can say which.
 */
function parseRoute(text) {
  const tokens = String(text || '')
    .toUpperCase()
    .split(/[\s,]+/)
    .filter((t) => t && t !== 'DCT');
  const unknown = tokens.filter((t) => !findFix(t));
  if (unknown.length) {
    const err = new Error(`Unknown waypoint${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return tokens.map(findFix);
}

module.exports = { findRoute, parseRoute, MAX_LEG_NM };
