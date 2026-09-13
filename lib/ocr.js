// Thin wrapper around tesseract.js for reading the HUD text region (aircraft
// type + speed). Kept separate from marker.js/calibration.js so the pure,
// easily-testable math lives apart from anything that needs a real
// Tesseract worker (which is slow to spin up and not worth mocking here).

const { createWorker } = require('tesseract.js');

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng');
  }
  return workerPromise;
}

/**
 * image: anything tesseract.js accepts - a data URL, a Buffer, or a canvas.
 * Returns the raw recognized text (trimmed); parsing that into a specific
 * aircraft type / speed shape is left to the caller, since the exact HUD
 * layout isn't confirmed yet.
 */
async function recognizeText(image) {
  const worker = await getWorker();
  const { data } = await worker.recognize(image);
  return (data.text || '').trim();
}

/**
 * Parses the info box below the compass tape - observed real layout:
 *   A220
 *   Speed          Altitude
 *   241kts         447ft
 * (Throttle/Flaps/Fuel/Keybinds/Delete are also in this box but aren't
 * needed for position tracking, so they're ignored here.)
 */
function parseFlightInfo(rawText) {
  if (!rawText) return { aircraftType: null, speedKts: null, altitudeFt: null };

  const speedMatch = rawText.match(/(\d{1,4})\s*kts?\b/i);
  const altitudeMatch = rawText.match(/(\d{1,6})\s*ft\b/i);

  // The aircraft type is a short alphanumeric token (e.g. "A220", "C172")
  // on its own line, before "Speed" appears - not a bare number, so it
  // won't collide with the speed/altitude matches above.
  const typeMatch = rawText.match(/\b([A-Z]{1,2}\d{2,4}(?:-\d+)?)\b/);

  return {
    aircraftType: typeMatch ? typeMatch[1] : null,
    speedKts: speedMatch ? Number(speedMatch[1]) : null,
    altitudeFt: altitudeMatch ? Number(altitudeMatch[1]) : null,
  };
}

/**
 * Parses the compass tape above the info box - observed layout has the
 * current heading as a standalone 1-3 digit number (e.g. "066") separate
 * from the compass-point letters (N/NE/E/etc.) around it.
 */
function parseHeadingTape(rawText) {
  if (!rawText) return null;
  const match = rawText.match(/(?<![A-Za-z0-9])(\d{1,3})(?![A-Za-z0-9])/);
  if (!match) return null;
  const heading = Number(match[1]);
  return heading >= 0 && heading <= 360 ? heading : null;
}

async function terminate() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  await worker.terminate();
  workerPromise = null;
}

module.exports = { recognizeText, parseFlightInfo, parseHeadingTape, terminate };
