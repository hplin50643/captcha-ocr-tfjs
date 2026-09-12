const fs = require("fs");
const path = require("path");
const D = require("../src/dataset");
const U = require("../src/image-utils");
const { requirePackage } = require("../src/dependencies");
const { loadRecognizer, recognizeSegments } = require("../src/ocr");
const { PNG } = requirePackage("pngjs");
const jpeg = requirePackage("jpeg-js");
const ORIGIN = "https://admis.nhri.edu.tw";

function qualifies(result, threshold = 0.99) {
  return (
    result.digits.length > 0 &&
    Number.isFinite(result.minConfidence) &&
    result.minConfidence < threshold
  );
}

async function collectHard(options = {}) {
  const root = options.root || D.ROOT;
  const batchId = options.batch || "hard-20260912";
  if (!/^[a-zA-Z0-9_-]+$/.test(batchId)) throw new Error("Invalid batch name.");
  const target = Number(options.count || 100),
    interval = Math.max(2000, Number(options.intervalMs || 2000));
  const maxAttempts = Number(options.maxAttempts || 5000);
  if (
    !Number.isInteger(target) ||
    target < 1 ||
    !Number.isFinite(interval) ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < target
  )
    throw new Error("Invalid count, interval, or max-attempts.");
  const stateFile = D.resolveInside(root, `data/collections/${batchId}.json`);
  const modelDir = D.resolveInside(root, "models/labeler-baseline");
  const modelSha256 = D.modelFingerprint(modelDir);
  const preprocessingSha256 = D.hash(
    fs.readFileSync(path.join(__dirname, "../src/preprocess-core.js"))
  );
  const state = D.readJson(stateFile, {
    version: 2,
    batchId,
    origin: ORIGIN,
    target,
    selection: "minConfidence < 0.99",
    threshold: 0.99,
    modelSha256,
    preprocessingSha256,
    entries: [],
    seenHashes: [],
    attempts: 0,
    startedAt: new Date().toISOString()
  });
  if (
    state.target !== target ||
    state.modelSha256 !== modelSha256 ||
    state.preprocessingSha256 !== preprocessingSha256
  )
    throw new Error("Resume requires the original target, scoring model, and preprocessing.");
  const save = () => {
    state.updatedAt = new Date().toISOString();
    state.remaining = Math.max(0, target - state.entries.length);
    D.writeJson(stateFile, state);
  };
  const knownFiles = [
    ...U.walkImageFiles(path.join(root, "data/raw")),
    ...U.walkImageFiles(path.join(root, "data/review/raw")),
    ...U.walkImageFiles(path.resolve(root, "../Captcha"))
  ];
  const existing = new Set(knownFiles.map((f) => D.hash(fs.readFileSync(f))));
  if (state.pending) {
    const file = D.resolveInside(root, state.pending.path);
    if (fs.existsSync(file)) {
      if (D.hash(fs.readFileSync(file)) !== state.pending.sha256)
        throw new Error("Interrupted download hash mismatch.");
      if (!state.entries.some((e) => e.sha256 === state.pending.sha256))
        state.entries.push(state.pending);
    }
    delete state.pending;
    save();
  }
  if (state.entries.some((e) => !existing.has(e.sha256)))
    throw new Error("A retained image is missing; restore it before resuming.");
  if (state.entries.length >= target) {
    state.status = "complete";
    save();
    console.log(`Already complete: ${state.entries.length}/${target}`);
    return state;
  }
  const seen = new Set([...existing, ...state.seenHashes]);
  const recognizer = await loadRecognizer(modelDir);
  const cookies = new Map([["locale", "tw"]]);
  let lastRequest = 0;
  async function request(url) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, interval - (Date.now() - lastRequest)))
    );
    lastRequest = Date.now();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      redirect: "error",
      headers: {
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        Referer: `${ORIGIN}/`,
        "Cache-Control": "no-cache"
      }
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0],
        i = pair.indexOf("=");
      if (i > 0) cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}; stopped without retrying.`);
    return response;
  }
  state.status = "collecting";
  delete state.error;
  save();
  try {
    await (await request(`${ORIGIN}/`)).arrayBuffer();
    while (state.entries.length < target && state.attempts < maxAttempts) {
      state.attempts++;
      const response = await request(`${ORIGIN}/api/Login/GetCaptcha?${Date.now()}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpg = bytes[0] === 255 && bytes[1] === 216;
      if (!png && !jpg) throw new Error("Response is not PNG/JPEG; stopped.");
      const sha256 = D.hash(bytes);
      if (seen.has(sha256)) {
        save();
        continue;
      }
      const decoded = png ? PNG.sync.read(bytes) : jpeg.decode(bytes, { useTArray: true });
      if (decoded.width < 30 || decoded.height < 10)
        throw new Error("Unexpected image dimensions.");
      const result = await recognizeSegments(
        U.segmentImageData(decoded, recognizer.preprocessing),
        recognizer
      );
      if (qualifies(result)) {
        const filename = `${batchId}_${String(state.entries.length + 1).padStart(3, "0")}_${sha256.slice(0, 12)}.${png ? "png" : "jpg"}`;
        const relative = `data/review/raw/${filename}`;
        const entry = {
          sha256,
          originalFilename: filename,
          path: relative,
          collectedAt: new Date().toISOString(),
          width: decoded.width,
          height: decoded.height,
          prediction: result.text,
          minConfidence: result.minConfidence,
          confidences: result.digits.map((d) => d.confidence),
          segmentationQuality: result.segmentationQuality
        };
        state.pending = entry;
        save();
        U.ensureDir(path.dirname(D.resolveInside(root, relative)));
        fs.writeFileSync(D.resolveInside(root, relative), bytes, { flag: "wx" });
        state.entries.push(entry);
        delete state.pending;
        console.log(
          `Retained ${state.entries.length}/${target}; attempts=${state.attempts}; min=${(100 * result.minConfidence).toFixed(3)}%; valid=${result.segmentationQuality.valid}`
        );
      }
      seen.add(sha256);
      state.seenHashes.push(sha256);
      save();
      if (state.attempts % 25 === 0)
        console.log(`Screened ${state.attempts}; retained ${state.entries.length}/${target}`);
    }
    state.status = state.entries.length === target ? "complete" : "incomplete";
    save();
    console.log(
      `Collection ${state.status}: ${state.entries.length}/${target}, ${state.attempts} attempts`
    );
    return state;
  } catch (error) {
    state.status = "stopped";
    state.error = error.message;
    save();
    throw error;
  }
}

if (require.main === module) {
  const options = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, value] = arg.replace(/^--/, "").split("=");
      return [key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value];
    })
  );
  collectHard(options).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { collectHard, qualifies };
