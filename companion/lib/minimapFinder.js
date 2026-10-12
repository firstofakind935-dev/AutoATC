// Finds PTFS's minimap on the screen, so nobody has to draw a box around it. (Port of the tracker's
// src/minimap_finder.py, with the same numbers.)
//
// The minimap panel always has the same dark slate buttons in its corners (expand top-left, X top-right, "/"
// bottom-left, "+" / "-" stacked bottom-right), each a small square with a white glyph. Those squares are found
// by colour, and the panel is the rectangle they frame - at any resolution or UI scale, wherever it sits. A panel
// must also look like a map inside (sea blue or land green), so other dark UI with similar buttons is not taken.
//
// Works on plain {width, height, data} RGBA objects (same shape as canvas ImageData).

const BUTTON = [44, 51, 57]; // RGB of the corner buttons' fill
const BUTTON_TOLERANCE = 40; // summed |R|+|G|+|B| distance
const SEA = [59, 90, 125]; // RGB of the minimap's sea

const near = (data, o, c, tol) => Math.abs(data[o] - c[0]) + Math.abs(data[o + 1] - c[1]) + Math.abs(data[o + 2] - c[2]) < tol;

/** 1 where a pixel has the buttons' colour. */
function slateMask({ width, height, data }) {
  const m = new Uint8Array(width * height);
  for (let i = 0, o = 0; i < m.length; i++, o += 4) m[i] = near(data, o, BUTTON, BUTTON_TOLERANCE) ? 1 : 0;
  return m;
}

/** Morphological close (dilate then erode) with a k x k square, to fill the glyph strokes inside each button. */
function close(mask, width, height, k) {
  const r = (k - 1) >> 1;
  const pass = (src, keep) => {
    // separable: rows then columns; keep=1 -> dilate (any), keep=0 -> erode (all)
    const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = keep ? 0 : 1;
        for (let d = -r; d <= r; d++) {
          const xx = x + d;
          const s = xx < 0 || xx >= width ? (keep ? 0 : 1) : src[y * width + xx];
          if (keep ? s : !s) { v = keep; break; }
        }
        tmp[y * width + x] = v;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = keep ? 0 : 1;
        for (let d = -r; d <= r; d++) {
          const yy = y + d;
          const s = yy < 0 || yy >= height ? (keep ? 0 : 1) : tmp[yy * width + x];
          if (keep ? s : !s) { v = keep; break; }
        }
        out[y * width + x] = v;
      }
    }
    return out;
  };
  return pass(pass(mask, 1), 0);
}

/** Connected components (8-way) of a 0/1 mask -> [{x, y, w, h, area}]. */
function components(mask, width, height) {
  const label = new Int32Array(width * height);
  const out = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, area = 0;
    label[start] = out.length + 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const px = p % width, py = (p - px) / width;
      area += 1;
      if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (mask[q] && !label[q]) { label[q] = out.length + 1; stack.push(q); }
        }
      }
    }
    out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  return out;
}

/** Dark slate squares with a bright glyph inside: [{x, y, w, h}]. */
function buttons(image, slate) {
  const { width, height, data } = image;
  const closed = close(slate, width, height, height < 900 ? 3 : 5);
  const lo = height * 0.012, hi = height * 0.08;
  const found = [];
  for (const c of components(closed, width, height)) {
    const { x, y, w, h, area } = c;
    if (!(lo <= w && w <= hi && lo <= h && h <= hi) || Math.max(w, h) > 1.6 * Math.min(w, h)) continue;
    if (area < 0.5 * w * h) continue;
    let bright = 0;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const o = (yy * width + xx) * 4;
        if (Math.min(data[o], data[o + 1], data[o + 2]) > 130) bright += 1;
      }
    }
    if (bright < 0.03 * w * h) continue; // needs a white glyph
    found.push({ x, y, w, h });
  }
  return found;
}

/** Most of a minimap is sea blue or land green; a dark UI panel with similar buttons is neither. */
function looksLikeMap({ width, data }, x0, y0, x1, y1) {
  let sea = 0, green = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      if (near(data, o, SEA, 45)) sea += 1;
      else if (g > r + 15 && g > b + 15) green += 1;
      n += 1;
    }
  }
  return n > 0 && (sea + green) / n > 0.35;
}

/**
 * image: a full screenshot (RGBA). Returns {x, y, w, h} of the minimap panel in that screenshot's pixels, or null
 * when it isn't on screen.
 */
function findMinimap(image) {
  const { width, height } = image;
  const slate = slateMask(image);
  const sat = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += slate[y * width + x];
      sat[(y + 1) * (width + 1) + x + 1] = sat[y * (width + 1) + x + 1] + row;
    }
  }
  const density = (x0, y0, x1, y1) => {
    x0 = Math.max(Math.round(x0), 0); y0 = Math.max(Math.round(y0), 0);
    x1 = Math.min(Math.round(x1), width); y1 = Math.min(Math.round(y1), height);
    if (x1 <= x0 || y1 <= y0) return 0;
    const s = sat[y1 * (width + 1) + x1] - sat[y0 * (width + 1) + x1] - sat[y1 * (width + 1) + x0] + sat[y0 * (width + 1) + x0];
    return s / ((x1 - x0) * (y1 - y0));
  };
  const list = buttons(image, slate);
  let best = null;
  for (const tl of list) {
    const s = (tl.w + tl.h) / 2;
    for (const tr of list) {
      // top-right: same row, similar size, at least ~4 buttons further right
      if (tr === tl || Math.abs(tr.y - tl.y) > s * 0.4 || tr.x - tl.x < 4 * s || Math.abs(tr.h - tl.h) > s * 0.5) continue;
      const x0 = tl.x, y0 = Math.min(tl.y, tr.y), x1 = tr.x + tr.w;
      const w = x1 - x0;
      // The bottom edge: both bottom corners hold buttons ("/" left, "+"/"-" right) and the panel ends there.
      for (let h = Math.floor(w * 1.4); h > Math.floor(w * 0.7); h--) {
        const y1 = y0 + h;
        if (y1 > height) continue;
        if (density(x0, y1 - s * 0.8, x0 + s * 0.8, y1) < 0.4 || density(x1 - s * 0.8, y1 - s * 0.8, x1, y1) < 0.4) continue;
        const below = Math.max(density(x0, y1 + 2, x0 + s, y1 + 2 + s * 0.5), density(x1 - s, y1 + 2, x1, y1 + 2 + s * 0.5));
        if (y1 + 2 < height && below > 0.3) continue;
        if (looksLikeMap(image, Math.round(x0 + s), Math.round(y0 + s), Math.round(x1 - s), Math.round(y1 - s)) && (!best || w * h > best.w * best.h)) {
          best = { x: x0, y: y0, w, h };
        }
        break;
      }
    }
  }
  return best;
}

/**
 * The panel image with its four corner buttons painted over in sea colour (a copy). They are fixed on screen, so
 * their edges and glyphs belong to no place on the map - over open sea they are almost the only features left, and
 * the matcher must not try to place them.
 */
function blankButtons(panel) {
  const { width, height } = panel;
  const data = new Uint8ClampedArray(panel.data);
  const s = Math.round(Math.min(width, height) * 0.15);
  const fill = (x0, y0, w, h) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const o = (y * width + x) * 4;
        data[o] = SEA[0]; data[o + 1] = SEA[1]; data[o + 2] = SEA[2]; data[o + 3] = 255;
      }
    }
  };
  fill(0, 0, s, s);
  fill(width - s, 0, s, s);
  fill(0, height - s, s, s);
  fill(width - s, height - Math.round(s * 2.1), s, Math.round(s * 2.1)); // "+" and "-" are stacked
  return { width, height, data };
}

module.exports = { findMinimap, blankButtons };
