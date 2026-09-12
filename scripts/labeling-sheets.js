// Original pixels and normalized crops, with no model answer shown to the reviewer.
const fs = require("fs");
const path = require("path");
const D = require("../src/dataset");
const U = require("../src/image-utils");
const { requirePackage } = require("../src/dependencies");
const { PNG } = requirePackage("pngjs");

function sheets(batchId) {
  if (!batchId || !/^[a-zA-Z0-9_-]+$/.test(batchId)) throw new Error("Invalid batch.");
  const batch = D.readJson(path.join(D.ROOT, `data/collections/${batchId}.json`));
  if (!batch) throw new Error("Unknown collection.");
  const manifest = D.readJson(path.join(D.ROOT, "data/manifest.json"), { samples: [] });
  const byId = new Map(manifest.samples.map((s) => [s.id, s]));
  const dir = path.join(D.ROOT, `reports/hard-examples/${batchId}`);
  U.ensureDir(dir);
  const font = {
    0: [7, 5, 5, 5, 7],
    1: [2, 6, 2, 2, 7],
    2: [7, 1, 7, 4, 7],
    3: [7, 1, 7, 1, 7],
    4: [5, 5, 7, 1, 1],
    5: [7, 4, 7, 1, 7],
    6: [7, 4, 7, 5, 7],
    7: [7, 1, 1, 1, 1],
    8: [7, 5, 7, 5, 7],
    9: [7, 5, 7, 1, 7]
  };
  const index = [];
  for (let offset = 0; offset < batch.entries.length; offset += 20) {
    const rows = batch.entries.slice(offset, offset + 20);
    const canvas = new PNG({ width: 1040, height: 145 * Math.ceil(rows.length / 4) });
    canvas.data.fill(255);
    function pixel(x, y, r, g, b) {
      const i = (y * canvas.width + x) * 4;
      canvas.data[i] = r;
      canvas.data[i + 1] = g;
      canvas.data[i + 2] = b;
      canvas.data[i + 3] = 255;
    }
    function draw(image, x0, y0, w, h) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i =
            (Math.floor((y * image.height) / h) * image.width + Math.floor((x * image.width) / w)) *
            4;
          pixel(x0 + x, y0 + y, image.data[i], image.data[i + 1], image.data[i + 2]);
        }
    }
    rows.forEach((entry, k) => {
      const number = offset + k + 1,
        x = (k % 4) * 260 + 4,
        y = Math.floor(k / 4) * 145 + 4;
      String(number)
        .padStart(3, "0")
        .split("")
        .forEach((c, j) =>
          font[c].forEach((bits, cy) => {
            for (let cx = 0; cx < 3; cx++)
              if (bits & (1 << (2 - cx)))
                for (let a = 0; a < 3; a++)
                  for (let b = 0; b < 3; b++)
                    pixel(x + j * 13 + cx * 3 + a, y + cy * 3 + b, 20, 35, 50);
          })
        );
      const file = path.join(D.ROOT, byId.get(entry.sha256)?.rawPath || entry.path);
      const decoded = U.decodeImage(file),
        segmented = U.segmentRawImageFile(file);
      draw(decoded, x, y + 22, 250, 50);
      segmented.segments.forEach((digit, i) => {
        const target = path.join(dir, `${String(number).padStart(3, "0")}_${i}.png`);
        U.writeNormalizedPng(digit.input, 32, target);
        if (i < 5) draw(U.decodeImage(target), x + i * 50, y + 80, 44, 44);
      });
      index.push({
        number,
        id: entry.sha256,
        file: D.relative(D.ROOT, file),
        valid: segmented.quality.valid,
        inputHashes: segmented.segments.map((s) => D.hash(Buffer.from(s.input))),
        sheet: `sheet-${Math.floor(offset / 20) + 1}.png`
      });
    });
    fs.writeFileSync(
      path.join(dir, `sheet-${Math.floor(offset / 20) + 1}.png`),
      PNG.sync.write(canvas)
    );
  }
  D.writeJson(path.join(dir, "index.json"), index);
  console.log(`Rendered ${index.length} sources without model answers.`);
}
if (require.main === module) sheets(process.argv[2]);
module.exports = { sheets };
