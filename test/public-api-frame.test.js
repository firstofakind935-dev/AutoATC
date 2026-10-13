// /api/public/v1/frame: the same transforms as data/gameFrame.json, and its inverses really are inverses.
const test = require('node:test');
const assert = require('node:assert');
const { FRAME } = require('../monitor/publicApi');
const gameFrame = require('../data/gameFrame.json');

const apply = (M, [u, v]) => [M[0][0] * u + M[0][1] * v + M[0][2], M[1][0] * u + M[1][1] * v + M[1][2]];

test('frame matches data/gameFrame.json', () => {
  assert.deepStrictEqual(FRAME.gridFromGame, gameFrame.gridFromGame);
  assert.deepStrictEqual(FRAME.spyFromGame, gameFrame.spyFromGame);
});

test('inverses round-trip, and 24SPY -> grid goes through the game frame', () => {
  for (const p of [[0, 0], [-467.9, 275.7], [454.5, -4.4]]) {
    const back = apply(FRAME.gameFromGrid, apply(FRAME.gridFromGame, p));
    assert.ok(Math.hypot(back[0] - p[0], back[1] - p[1]) < 1e-9);
    const viaSpy = apply(FRAME.gridFromSpy, apply(FRAME.spyFromGame, p));
    const direct = apply(FRAME.gridFromGame, p);
    assert.ok(Math.hypot(viaSpy[0] - direct[0], viaSpy[1] - direct[1]) < 1e-9);
  }
});

test('Rockford runway 07 threshold (game units) lands next to the Rockford airport point', () => {
  const irfd = apply(FRAME.gridFromGame, [-34.0, 214.0]);
  assert.ok(irfd[0] > 20 && irfd[0] < 21.5 && irfd[1] > 20.5 && irfd[1] < 22, irfd.join(','));
});
