const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL, fileURLToPath } = require("url");
const D = require("../src/dataset");
const U = require("../src/image-utils");
const core = require("../src/preprocess-core");
const tf = require("../src/tf");
const { loadRecognizer } = require("../src/ocr");
const { extensionDirectory } = require("../src/config");
const extension = extensionDirectory();

test("extension contains the current shared preprocessing source", () => {
  assert.equal(
    fs.readFileSync(path.join(extension, "src/preprocess.js"), "utf8"),
    fs.readFileSync(path.join(D.ROOT, "src/preprocess-core.js"), "utf8")
  );
});

test("extension native Dense runner matches TensorFlow probabilities", async () => {
  const context = {
    window: {},
    URL,
    Float32Array,
    fetch: async (url) => {
      const bytes = fs.readFileSync(fileURLToPath(url));
      return {
        ok: true,
        json: async () => JSON.parse(bytes),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(extension, "src/model-runner.js"), "utf8"), context);
  const runner = await context.window.AdmisCaptchaModelRunner.loadModel(
    pathToFileURL(path.join(extension, "model/model.json")).href
  );
  const recognizer = await loadRecognizer();
  for (const filename of [
    path.join(D.ROOT, "data/raw/14662.png"),
    path.join(__dirname, "fixtures/42385-edge-noise.png")
  ]) {
    const segments = U.segmentRawImageFile(filename).segments;
    for (const segment of segments) {
      const xs = tf.tensor4d(segment.input, [1, 32, 32, 1]),
        ys = recognizer.model.predict(xs);
      const expected = await ys.data(),
        actual = runner.predict(segment.input);
      for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(expected[i] - actual[i]) < 1e-5);
      xs.dispose();
      ys.dispose();
    }
  }
});

test("extension uses the 95% boundary, rejects stale images and preserves manual input", () => {
  const { decide, MIN_CONFIDENCE } = require(path.join(extension, "src/fill-policy"));
  assert.equal(MIN_CONFIDENCE, 0.95);
  const quality = { valid: true, expectedCount: 5 };
  const digits = [1, 1, 1, 1, 0.95].map((confidence) => ({ confidence }));
  const result = {
    text: "42385",
    ...core.summarizeDigits(digits, quality, MIN_CONFIDENCE),
    segmentationQuality: quality
  };
  assert.equal(result.needsReview, false);
  assert.equal(core.summarizeDigits(digits, quality).needsReview, true); // Dataset/API default remains 99%.
  const base = {
    sameImage: true,
    sameInput: true,
    startingValue: "",
    currentValue: "",
    manualEditChanged: false,
    result
  };
  assert.equal(decide(base), "fill");
  assert.equal(decide({ ...base, sameImage: false }), "stale");
  assert.equal(decide({ ...base, sameInput: false }), "stale");
  assert.equal(decide({ ...base, startingValue: "12345", currentValue: "12345" }), "manual");
  assert.equal(decide({ ...base, currentValue: "423" }), "manual");
  assert.equal(decide({ ...base, manualEditChanged: true }), "manual");
  assert.equal(decide({ ...base, result: { ...base.result, minConfidence: 0.989999 } }), "fill");
  assert.equal(
    decide({ ...base, result: { ...base.result, minConfidence: 0.949999 } }),
    "fill-review"
  );
  assert.equal(decide({ ...base, result: { ...base.result, minConfidence: NaN } }), "review");
  assert.equal(decide({ ...base, result: { ...base.result, text: "4238" } }), "review");
  assert.equal(decide({ ...base, result: { ...base.result, needsReview: true } }), "fill-review");
  assert.equal(
    decide({ ...base, result: { ...base.result, segmentationQuality: { valid: false } } }),
    "review"
  );
});

test("content script fills low-confidence candidates with yellow status and keeps manual values", async () => {
  async function run(confidence, valid = true, manualValue = "") {
    let scheduled,
      status = null;
    const events = [];
    const input = { value: manualValue, dispatchEvent: (event) => events.push(event.type) };
    const img = {
      currentSrc: "https://admis.nhri.edu.tw/api/Login/GetCaptcha",
      complete: true,
      naturalWidth: 250,
      naturalHeight: 50,
      insertAdjacentElement: (_, node) => {
        status = node;
      }
    };
    const labels = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const context = {
      console: {
        info() {},
        warn() {},
        error(error) {
          throw error;
        }
      },
      URL,
      chrome: { runtime: { getURL: (file) => file } },
      HTMLInputElement: class {},
      Event: class {
        constructor(type) {
          this.type = type;
        }
      },
      MutationObserver: class {
        observe() {}
      },
      document: {
        getElementById: () => ({}),
        addEventListener() {},
        documentElement: {},
        querySelector: (selector) =>
          selector.startsWith("img[") ? img : selector.startsWith("input[") ? input : status,
        createElement: (tag) =>
          tag === "canvas"
            ? { getContext: () => ({ drawImage() {}, getImageData: () => ({}) }) }
            : { dataset: {}, textContent: "" }
      },
      location: { href: "https://admis.nhri.edu.tw/" },
      addEventListener() {},
      setTimeout: (fn) => {
        scheduled = fn;
        return 1;
      },
      clearTimeout() {},
      fetch: async (file) => ({
        ok: true,
        json: async () => (file.endsWith("labels.json") ? labels : {})
      }),
      AdmisCaptchaPreprocess: {
        ...core,
        segmentImageData: () => ({
          method: "projection",
          quality: { valid, expectedCount: 5 },
          segments: [3, 1, 2, 7, 4].map((labelIndex, index) => ({ input: [labelIndex, index] }))
        })
      },
      AdmisCaptchaModelRunner: {
        loadModel: async () => ({
          predict: ([labelIndex, index]) =>
            labels.map((_, i) =>
              i === labelIndex
                ? index === 0
                  ? confidence
                  : 1
                : index === 0
                  ? (1 - confidence) / 8
                  : 0
            )
        })
      }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(extension, "src/fill-policy.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(extension, "src/content.js"), "utf8"), context);
    await scheduled();
    return { value: input.value, state: status.dataset.state, message: status.textContent, events };
  }
  const low = await run(0.949999);
  assert.equal(low.value, "42385");
  assert.equal(low.state, "warning");
  assert.match(low.message, /已填入候選.*請人工確認/);
  assert.deepEqual(low.events, ["input", "change", "blur"]);
  const boundary = await run(0.95);
  assert.equal(boundary.value, "42385");
  assert.equal(boundary.state, "ok");
  const invalid = await run(0.94, false);
  assert.equal(invalid.value, "");
  assert.equal(invalid.state, "warning");
  assert.equal(invalid.events.length, 0);
  const manual = await run(0.94, true, "123");
  assert.equal(manual.value, "123");
  assert.equal(manual.state, "warning");
  assert.equal(manual.events.length, 0);
});
