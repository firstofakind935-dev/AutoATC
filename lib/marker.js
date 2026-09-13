// Finds the aircraft marker on the minimap by color: scans a cropped
// ImageData-shaped region for pixels within a green color range and returns
// their centroid. Operates on a plain {width, height, data} object (the same
// shape as browser/canvas ImageData) so it works both in the Electron
// renderer (real canvas) and in a plain Node test with a synthetic object.

const DEFAULT_GREEN = {
  // Matches a fairly saturated, mid-to-bright green - tune against the real
  // marker color once we can sample it from an actual screenshot.
  minG: 120,
  maxRDelta: 90, // G must exceed R by at least this much
  maxBDelta: 90, // G must exceed B by at least this much
};

function pixelIsMarkerGreen(r, g, b, opts) {
  return g >= opts.minG && g - r >= opts.maxRDelta && g - b >= opts.maxBDelta;
}

/**
 * imageData: { width, height, data } where data is a flat RGBA Uint8ClampedArray-like
 * (4 bytes per pixel: r,g,b,a), matching CanvasRenderingContext2D#getImageData().
 * Returns { x, y, pixelCount } in the image's own pixel coordinates, or null
 * if no matching pixels were found.
 */
function findMarkerCentroid(imageData, opts = {}) {
  const options = { ...DEFAULT_GREEN, ...opts };
  const { width, height, data } = imageData;

  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (pixelIsMarkerGreen(r, g, b, options)) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count === 0) return null;
  return { x: sumX / count, y: sumY / count, pixelCount: count };
}

module.exports = { findMarkerCentroid, pixelIsMarkerGreen, DEFAULT_GREEN };
