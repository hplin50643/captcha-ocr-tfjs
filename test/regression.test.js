const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const D = require("../src/dataset");
const U = require("../src/image-utils");
const core = require("../src/preprocess-core");
const { solveCaptchaFile } = require("../src/ocr");
const { prepare, rawDestination } = require("../scripts/prepare-data");
const { importReviews } = require("../scripts/review-import");
const { loadSplitSamples, parseArgs } = require("../scripts/train");
const { requirePackage } = require("../src/dependencies");
const tf = require("../src/tf");
const { PNG } = requirePackage("pngjs");
const manifest = D.readJson(path.join(D.ROOT, "data/manifest.json"));

function synthetic(rectangles, width = 190, height = 50) {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [x0, y0, w, h] of rectangles)
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const p = (y * width + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
      }
  return { width, height, data };
}
function browserCore() {
  const context = {};
  const script = path.join(D.ROOT, "src/preprocess-core.js");
  vm.runInNewContext(fs.readFileSync(script, "utf8"), context);
  return context.AdmisCaptchaPreprocess;
}

test("all 25 user labels remain correct; screenshot excludes the edge artifact", async () => {
  const samples = manifest.samples.filter((s) => s.labelSource === "user-filename");
  assert.equal(samples.length, 25);
  for (const s of samples) {
    const result = await solveCaptchaFile(path.join(D.ROOT, s.rawPath));
    assert.equal(result.text, s.label, s.rawPath);
    assert.equal(result.segmentationQuality.valid, true);
  }
  const result = await solveCaptchaFile(path.join(__dirname, "fixtures/42385-edge-noise.png"));
  assert.equal(result.text, "42385");
  assert.equal(result.segmentationQuality.actualCount, 5);
  assert.ok(result.segmentationQuality.removedNoise.length > 0);
  assert.equal(result.needsReview, result.minConfidence < 0.99);
});

test("tall thin 1 and edge characters survive; short edge noise is removed", () => {
  const rectangles = [
    [0, 8, 2, 30],
    [35, 10, 12, 29],
    [70, 9, 12, 30],
    [105, 8, 12, 30],
    [140, 10, 12, 30],
    [187, 25, 3, 3]
  ];
  const result = core.segmentImageData(synthetic(rectangles));
  assert.equal(result.segments.length, 5);
  assert.equal(result.segments[0].bbox.x, 0);
  assert.equal(result.quality.valid, true);
  assert.equal(result.quality.removedNoise.length, 1);
});

test("detached lower stroke of a clipped leading 2 survives cleaning and reaches 99%", async () => {
  const file = path.join(__dirname, "fixtures/22329-detached-stroke.png");
  const image = U.decodeImage(file);
  const thresholded = core.binarizeDecodedImage(image);
  const segmented = core.segmentImageData(image);
  const bbox = segmented.segments[0].bbox;
  assert.deepEqual(bbox, { x: 0, y: 7, width: 15, height: 35 });
  // No foreground in this character column may disappear as relative noise.
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < bbox.width; x++) {
      if (thresholded[y * image.width + x]) assert.equal(segmented.binary[y * image.width + x], 1);
    }
  assert.ok(segmented.quality.retainedFragments.some((c) => c.x === 0 && c.y === 33));
  assert.ok(segmented.quality.removedNoise.every((c) => c.x > bbox.x + bbox.width));
  const result = await solveCaptchaFile(file);
  assert.equal(result.text, "22329");
  assert.ok(result.digits[0].confidence >= 0.99);
  assert.equal(result.needsReview, false);
  for (const label of ["21629", "21652", "22873"]) {
    const sample = manifest.samples.find((s) => s.label === label);
    const current = await solveCaptchaFile(path.join(D.ROOT, sample.rawPath));
    assert.equal(current.text, label);
    assert.ok(current.digits[0].confidence >= 0.99);
  }
});

test("two-ended vertical bounds retain aligned caps and feet but discard separate noise", () => {
  const anchors = [0, 35, 70, 105, 140].map((x) => [x, 9, 12, 25]);
  const image = synthetic([
    ...anchors,
    [0, 3, 10, 4],
    [140, 36, 10, 4],
    [20, 36, 4, 3],
    [187, 25, 3, 3]
  ]);
  const result = core.segmentImageData(image);
  assert.equal(result.quality.valid, true);
  assert.equal(result.segments.length, 5);
  assert.equal(result.segments[0].bbox.y, 2);
  const last = result.segments[4].bbox;
  assert.equal(last.y + last.height - 1, 40);
  assert.equal(result.quality.retainedFragments.length, 2);
  assert.equal(result.quality.removedNoise.length, 2);
  assert.equal(result.binary[3 * image.width], 1);
  assert.equal(result.binary[39 * image.width + 140], 1);
  assert.equal(result.binary[36 * image.width + 20], 0);
});

test("close digits may split at a deep valley; six full shapes and blank input are rejected", () => {
  const touching = [
    [0, 8, 12, 30],
    [35, 8, 12, 30],
    [51, 8, 12, 30],
    [47, 25, 4, 1],
    [100, 8, 12, 30],
    [140, 8, 12, 30]
  ];
  const result = core.segmentImageData(synthetic(touching));
  assert.equal(result.segments.length, 5);
  assert.equal(result.quality.valid, true);
  assert.equal(result.quality.splitCount, 1);
  const six = core.segmentImageData(
    synthetic([0, 30, 60, 90, 120, 150].map((x) => [x, 8, 12, 30]))
  );
  assert.equal(six.segments.length, 6);
  assert.equal(six.quality.valid, false);
  const blank = core.segmentImageData(synthetic([]));
  assert.equal(blank.quality.valid, false);
  assert.deepEqual(core.summarizeDigits([], blank.quality), {
    confidence: 0,
    minConfidence: 0,
    needsReview: true
  });
});

test("classification uses each digit's exact 99% boundary, truth and geometry", () => {
  const valid = {
    confidence: 0.99,
    predictedLabel: "4",
    expectedLabel: "4",
    qualityValid: true,
    inputHash: "a"
  };
  assert.equal(D.classificationDecision(valid).status, "auto");
  assert.equal(D.classificationDecision({ ...valid, confidence: 0.989999 }).status, "review");
  assert.equal(
    D.classificationDecision({ ...valid, predictedLabel: "1", confidence: 1 }).status,
    "review"
  );
  assert.equal(D.classificationDecision({ ...valid, qualityValid: false }).status, "review");
  assert.equal(D.classificationDecision({ ...valid, expectedLabel: null }).status, "review");
  const approval = { label: "4", inputHash: "a" };
  assert.equal(D.classificationDecision({ ...valid, confidence: 0.5, approval }).status, "manual");
  assert.equal(
    D.classificationDecision({ ...valid, confidence: 0.5, approval, inputHash: "changed" }).status,
    "review"
  );
  const quality = { valid: true, expectedCount: 5 };
  assert.equal(
    core.summarizeDigits(
      [1, 1, 1, 1, 0.98].map((confidence) => ({ confidence })),
      quality
    ).needsReview,
    true
  );
  assert.equal(
    core.summarizeDigits(Array(5).fill({ confidence: 0.99 }), quality).needsReview,
    false
  );
});

test("preserved original hashes, accounted digits, numeric names and trusted provenance", () => {
  const frozen = D.readJson(path.join(D.ROOT, "data/regression-sources.json"));
  assert.equal(frozen.sources.length, 225);
  for (const source of frozen.sources) {
    const current = manifest.samples.find((s) => s.id === source.id);
    assert.ok(current);
    assert.equal(current.label, source.label);
    assert.equal(current.split, source.split);
  }
  assert.equal(manifest.samples.length, manifest.summary.rawImages);
  assert.equal(new Set(manifest.samples.map((s) => s.id)).size, manifest.samples.length);
  assert.equal(U.walkImageFiles(path.join(D.ROOT, "data/raw")).length, manifest.samples.length);
  assert.equal(manifest.samples.flatMap((s) => s.digits).length, manifest.summary.totalDigits);
  for (const s of manifest.samples) {
    assert.equal(D.labelFromFilename(s.rawPath), s.label);
    assert.ok(["user-filename", "visual-review", "user-review"].includes(s.labelSource));
    assert.equal(D.hash(fs.readFileSync(path.join(D.ROOT, s.rawPath))), s.id);
    for (const d of s.digits) {
      assert.ok(fs.existsSync(path.join(D.ROOT, d.path)));
      if (d.status === "auto") {
        assert.ok(d.confidence >= 0.99);
        assert.equal(d.predictedLabel, s.label[d.index]);
        assert.ok(s.segmentationQuality.valid);
      }
      assert.equal(d.status === "review", d.path.startsWith("data/review/digits/"));
    }
  }
});

test("source grouping keeps every new image in exactly one fixed 60/20/20 split", () => {
  for (const batch of D.sourceBatches(D.ROOT).collections.filter((b) => b.status === "complete")) {
    const ids = batch.entries.map((e) => e.sha256),
      mapping = D.splitCollected(ids, 42);
    assert.deepEqual(mapping, D.splitCollected([...ids].reverse(), 42));
    assert.deepEqual(
      ["train", "validation", "test"].map(
        (name) => Object.values(mapping).filter((s) => s === name).length
      ),
      [60, 20, 20]
    );
    for (const id of ids)
      assert.equal(manifest.samples.find((s) => s.id === id).split, mapping[id]);
  }
  const { splits } = loadSplitSamples(parseArgs(["node", "train"]));
  const sets = Object.fromEntries(
    Object.entries(splits).map(([name, samples]) => [name, new Set(samples.map((s) => s.sourceId))])
  );
  for (const id of sets.train) {
    assert.ok(!sets.validation.has(id));
    assert.ok(!sets.test.has(id));
  }
  for (const id of sets.validation) assert.ok(!sets.test.has(id));
  for (const name of ["validation", "test"])
    assert.equal(
      splits[name].length,
      manifest.samples
        .filter((s) => s.split === name && s.segmentationQuality.valid)
        .reduce((n, s) => n + s.digits.length, 0)
    );
  assert.ok(splits.train.every((s) => !s.filePath.includes(path.join("review", "digits"))));
});

test("Node and browser produce identical inputs and prepared PNGs are not reprocessed", () => {
  const browser = browserCore();
  for (const s of manifest.samples) {
    const file = path.join(D.ROOT, s.rawPath),
      node = U.segmentRawImageFile(file),
      web = browser.segmentImageData(U.decodeImage(file));
    assert.equal(JSON.stringify(node.quality), JSON.stringify(web.quality));
    for (const d of s.digits) {
      assert.deepEqual(
        Array.from(node.segments[d.index].input),
        Array.from(web.segments[d.index].input)
      );
      assert.deepEqual(
        Array.from(U.readNormalizedDigit(path.join(D.ROOT, d.path)).input),
        Array.from(node.segments[d.index].input)
      );
    }
  }
});

test("repeated OCR requests do not leak TensorFlow tensors", async () => {
  const file = path.join(D.ROOT, manifest.samples[0].rawPath);
  await solveCaptchaFile(file);
  const before = tf.memory().numTensors;
  for (let i = 0; i < 20; i++) await solveCaptchaFile(file);
  assert.equal(tf.memory().numTensors, before);
});

test("prepare and manual import are repeatable, collision safe, and keep approved labels", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "captcha-ocr-test-"));
  t.after(() => {
    const resolved = path.resolve(root),
      prefix = path.resolve(os.tmpdir()) + path.sep + "captcha-ocr-test-";
    assert.ok(resolved.startsWith(prefix));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "data/raw"), { recursive: true });
  fs.cpSync(
    path.join(D.ROOT, "models/labeler-baseline"),
    path.join(root, "models/labeler-baseline"),
    { recursive: true }
  );
  const raw = path.join(D.ROOT, "data/raw/14662.png");
  fs.copyFileSync(raw, path.join(root, "data/raw/14662.png"));
  const alternative = PNG.sync.read(fs.readFileSync(raw));
  alternative.data[(alternative.width - 1) * 4] ^= 1;
  const other = PNG.sync.write(alternative);
  fs.writeFileSync(path.join(root, "data/raw/unnamed.png"), other);
  D.writeJson(path.join(root, "data/raw-labels.json"), {
    [D.hash(other)]: { label: "14662", source: "visual-review" }
  });
  const reviewSource = manifest.samples.find(
    (s) => s.digits.some((d) => d.confidence < 0.99) && !s.rawPath.endsWith("14662.png")
  );
  fs.copyFileSync(
    path.join(D.ROOT, reviewSource.rawPath),
    path.join(root, "data/raw", path.basename(reviewSource.rawPath))
  );
  const first = await prepare(root);
  assert.equal(first.samples.length, 3);
  assert.ok(fs.existsSync(path.join(root, "data/raw/14662__02.png")));
  const second = await prepare(root);
  assert.deepEqual(
    second.samples.map((s) => [s.id, s.rawPath]).sort(),
    first.samples.map((s) => [s.id, s.rawPath]).sort()
  );
  assert.equal(U.walkImageFiles(path.join(root, "data/raw")).length, 3);
  const sample = second.samples.find((s) => s.id === reviewSource.id),
    digit = sample.digits.find((d) => d.status === "review");
  const correctLabel = sample.label[digit.index];
  const wrongLabel = correctLabel === "1" ? "2" : "1";
  const pendingFile = path.join(root, digit.path);
  const wrong = path.join(root, "data/review/confirmed", wrongLabel, path.basename(pendingFile));
  fs.copyFileSync(pendingFile, wrong);
  assert.throws(() => importReviews(root), /conflicts/);
  assert.ok(fs.existsSync(pendingFile));
  fs.unlinkSync(wrong);
  fs.renameSync(
    pendingFile,
    path.join(root, "data/review/confirmed", correctLabel, path.basename(pendingFile))
  );
  assert.equal(importReviews(root), 1);
  assert.equal(importReviews(root), 0);
  const third = await prepare(root);
  const approved = third.samples.find((s) => s.id === sample.id).digits[digit.index];
  assert.equal(approved.status, "manual");
  assert.equal(approved.label, correctLabel);
  assert.ok(fs.existsSync(path.join(root, approved.path)));
  assert.equal(D.labelFromFilename("42385__02.png"), "42385");
  assert.equal(D.labelFromFilename("captcha_001.jpg"), null);
  assert.throws(() => D.resolveInside(root, "../../escape"), /stay inside/);
  assert.equal(path.basename(rawDestination(root, "14662", ".png", "unused")), "14662__03.png");
  const beforeRejectedRun = fs.readFileSync(path.join(root, "data/manifest.json"), "utf8");
  D.writeJson(path.join(root, "data/raw-labels.json"), {
    [D.hash(other)]: { label: "11111", source: "user-review" }
  });
  await assert.rejects(() => prepare(root), /allowCorrection/);
  assert.equal(fs.readFileSync(path.join(root, "data/manifest.json"), "utf8"), beforeRejectedRun);
  assert.equal(fs.existsSync(path.join(root, "data/.prepare-stage")), false);
  assert.equal(U.walkImageFiles(path.join(root, "data/raw")).length, 3);
});
