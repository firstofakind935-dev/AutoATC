// Two-point calibration: the pilot clicks two airports on the in-game
// minimap whose real coordinates we already know (from ../data/charts), and
// we solve for the similarity transform (scale + rotation, no shear) that
// maps minimap pixels to lat/lon. This assumes the minimap is a fixed-extent
// map with the aircraft marker moving across it (north-up or a fixed
// rotation) - NOT a player-centered map that scrolls/rotates under a static
// marker. That assumption is unverified against the real game UI as of
// writing; if it turns out wrong, this calibration step is what needs to
// change, not the rest of the pipeline (marker detection, OCR, upload).
//
// Math: treat each pixel (u, v) and each world point (lon, lat) as complex
// numbers u+vi and lon+lat*i (lon/lat swapped from usual so "east/north" and
// "x/y" line up the same way). Two point pairs (P1,W1) and (P2,W2) fully
// determine a complex scale+rotation M and an origin:
//   M = (W2 - W1) / (P2 - P1)
//   W = W1 + M * (P - P1)   for any other pixel P

function toComplex(x, y) {
  return { re: x, im: y };
}

function sub(a, b) {
  return { re: a.re - b.re, im: a.im - b.im };
}

function add(a, b) {
  return { re: a.re + b.re, im: a.im + b.im };
}

function mul(a, b) {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function div(a, b) {
  const denom = b.re * b.re + b.im * b.im;
  if (denom === 0) throw new Error('Calibration points must not be identical pixels');
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom,
  };
}

/**
 * refPoints: [{ pixel: {x, y}, world: {lat, lon} }, { pixel, world }]
 * Returns a calibration object with a `project(pixel)` method.
 */
function buildCalibration(refPoints) {
  if (!Array.isArray(refPoints) || refPoints.length !== 2) {
    throw new Error('buildCalibration needs exactly 2 reference points');
  }
  const [r1, r2] = refPoints;
  const p1 = toComplex(r1.pixel.x, r1.pixel.y);
  const p2 = toComplex(r2.pixel.x, r2.pixel.y);
  // lon is the "real" axis (east/x-like), lat is the "imaginary" axis (north/y-like)
  const w1 = toComplex(r1.world.lon, r1.world.lat);
  const w2 = toComplex(r2.world.lon, r2.world.lat);

  const scaleRotation = div(sub(w2, w1), sub(p2, p1));

  function project(pixel) {
    const p = toComplex(pixel.x, pixel.y);
    const w = add(w1, mul(scaleRotation, sub(p, p1)));
    return { lon: w.re, lat: w.im };
  }

  return { refPoints, project };
}

module.exports = { buildCalibration };
