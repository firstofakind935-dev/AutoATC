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

// A separate, dedicated worker for the heading tape - it's a digit-only
// field (unlike the info box, which needs letters for the aircraft type),
// and confirmed real captures show Tesseract occasionally misreading one
// digit as another (a clean "194" read at one tick, then "174" moments
// later at the same real heading) - a character whitelist removes the
// letter-vs-digit hypothesis space entirely, which meaningfully improves
// digit disambiguation. Kept as its own worker (not shared, parameters
// swapped per call) so two ocrRegion() calls firing in parallel each tick
// can never race on which whitelist is active.
let headingWorkerPromise = null;

async function getHeadingWorker() {
  if (!headingWorkerPromise) {
    headingWorkerPromise = createWorker('eng').then(async (worker) => {
      await worker.setParameters({ tessedit_char_whitelist: '0123456789' });
      return worker;
    });
  }
  return headingWorkerPromise;
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

/** Same as recognizeText(), but via the digit-only worker - see getHeadingWorker(). */
async function recognizeHeadingText(image) {
  const worker = await getHeadingWorker();
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

  // Tesseract regularly reads a lone "0" (e.g. speed "0kts" while stationary/
  // taxiing - confirmed against a real log: "Okts Altitude 1243ft") as the
  // letter "O" instead of the digit - there's nothing else in the run to
  // anchor it as a digit. Accept O/o standing in for a leading zero here,
  // then normalize before parsing as a number.
  const speedMatch = rawText.match(/([0-9Oo][0-9Oo]{0,3})\s*kts?\b/i);
  const altitudeMatch = rawText.match(/(\d{1,6})\s*ft\b/i);

  // The aircraft type is a short alphanumeric token (e.g. "A220", "C172")
  // on its own line, before "Speed" appears - not a bare number, so it
  // won't collide with the speed/altitude matches above.
  const typeMatch = rawText.match(/\b([A-Z]{1,2}\d{2,4}(?:-\d+)?)\b/);

  return {
    aircraftType: typeMatch ? typeMatch[1] : null,
    speedKts: speedMatch ? Number(speedMatch[1].replace(/[Oo]/g, '0')) : null,
    altitudeFt: altitudeMatch ? Number(altitudeMatch[1]) : null,
  };
}

/**
 * Parses the compass tape above the info box - the real in-game layout
 * (confirmed against a screenshot) is the current heading as a 1-3 digit
 * number with its nearest compass-point letters butted directly against
 * it, no separator - e.g. "039NE", not "039 NE". A trailing
 * not-followed-by-a-letter lookahead here previously rejected exactly
 * that number (since a letter always follows it), falling through to
 * whatever other digits happened to be in the OCR'd text instead - only
 * guard the left side, so a match isn't grabbed from the middle of some
 * longer number.
 */
function parseHeadingTape(rawText) {
  if (!rawText) return null;
  const match = rawText.match(/(?<![A-Za-z0-9])(\d{1,3})/);
  if (!match) return null;
  const heading = Number(match[1]);
  return heading >= 0 && heading <= 360 ? heading : null;
}

async function terminate() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
  if (headingWorkerPromise) {
    const worker = await headingWorkerPromise;
    await worker.terminate();
    headingWorkerPromise = null;
  }
}

module.exports = { recognizeText, recognizeHeadingText, parseFlightInfo, parseHeadingTape, terminate };
