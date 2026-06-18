/**
 * generate-tray-icon.js
 *
 * Creates src/tray-icon.png — a 32x32 PNG used for the Windows system tray
 * icon (the .ico renders blank in the tray, a sized PNG does not).
 *
 * Written into src/ (not build/) because electron-builder's default
 * buildResources directory (build/) is NOT packaged into the app — anything
 * there is missing at runtime, leaving the tray blank.
 *
 * Resizes ../stroke-and-turn/public/icon-512.png down to 32x32 using a simple
 * box-average filter. Pure Node (pngjs only) so it runs with `node`:
 *
 *     node scripts/generate-tray-icon.js
 */

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const SRC = path.join(__dirname, "..", "..", "stroke-and-turn", "public", "icon-512.png");
const OUT = path.join(__dirname, "..", "src", "tray-icon.png");
const SIZE = 32;

function boxResize(src, size) {
  const out = new PNG({ width: size, height: size });
  const scaleX = src.width / size;
  const scaleY = src.height / size;

  for (let y = 0; y < size; y++) {
    const sy0 = Math.floor(y * scaleY);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < size; x++) {
      const sx0 = Math.floor(x * scaleX);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * scaleX));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (src.width * sy + sx) << 2;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }

      const o = (size * y + x) << 2;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Source icon not found: ${SRC}`);
    process.exit(1);
  }

  const src = PNG.sync.read(fs.readFileSync(SRC));
  const out = boxResize(src, SIZE);
  fs.writeFileSync(OUT, PNG.sync.write(out));
  console.log(`Wrote ${OUT} (${SIZE}x${SIZE})`);
}

main();
