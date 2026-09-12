const fs = require("fs");
const path = require("path");
const { loadRecognizer, recognizeSegments } = require("../src/ocr");
const {
  walkImageFiles,
  ensureDir,
  segmentRawImageFile,
  writeNormalizedPng
} = require("../src/image-utils");
const D = require("../src/dataset");

function rawDestination(root, label, ext, current) {
  const dir = D.resolveInside(root, "data/raw");
  ensureDir(dir);
  for (let index = 1; ; index++) {
    const name = `${label}${index === 1 ? "" : `__${String(index).padStart(2, "0")}`}${ext}`;
    const destination = D.resolveInside(root, `data/raw/${name}`);
    if (destination === current || !fs.existsSync(destination)) return destination;
  }
}

async function prepare(root = D.ROOT) {
  root = path.resolve(root);
  const manifestPath = D.resolveInside(root, "data/manifest.json");
  const old = D.readJson(manifestPath, { samples: [] });
  const previous = new Map(old.samples.map((s) => [s.id, s]));
  const labels = D.readJson(D.resolveInside(root, "data/raw-labels.json"), {});
  const approvals = D.readJson(D.resolveInside(root, "data/review/approvals.json"), {});
  const batches = D.sourceBatches(root),
    collected = new Map(),
    imported = new Map();
  for (const collection of batches.collections) {
    if (collection.entries.length && collection.status !== "complete")
      throw new Error(
        `Finish or resume collection ${collection.batchId} before assigning the fixed train/validation/test split.`
      );
    const splits = D.splitCollected(
      collection.entries.map((e) => e.sha256),
      42
    );
    for (const entry of collection.entries) {
      if (collected.has(entry.sha256))
        throw new Error(`Duplicate source across collection batches: ${entry.sha256}`);
      collected.set(entry.sha256, {
        ...entry,
        batchId: collection.batchId,
        split: splits[entry.sha256],
        selection: collection.selection || "random"
      });
    }
  }
  for (const batch of batches.imports)
    for (const entry of batch.entries)
      imported.set(entry.sha256, { ...entry, batchId: batch.batchId });
  const modelDir = D.resolveInside(root, "models/labeler-baseline");
  if (!fs.existsSync(modelDir))
    fs.cpSync(D.resolveInside(root, "model"), modelDir, { recursive: true });
  const fingerprint = D.modelFingerprint(modelDir);
  if (old.labelerModel && old.labelerModel.sha256 !== fingerprint)
    throw new Error(
      "Frozen labeling model changed. Restore models/labeler-baseline before preparing data."
    );
  const recognizer = await loadRecognizer(modelDir);
  const stage = D.resolveInside(root, "data/.prepare-stage");
  if (fs.existsSync(stage))
    throw new Error(
      "A prior staging directory exists. Inspect data/.prepare-stage before recovery."
    );
  ensureDir(stage);
  for (const label of D.LABELS) ensureDir(path.join(stage, "segmented", label));
  ensureDir(path.join(stage, "review-digits"));
  const files = [
    ...walkImageFiles(D.resolveInside(root, "data/raw")),
    ...walkImageFiles(D.resolveInside(root, "data/review/raw"))
  ].sort();
  const seen = new Set(),
    samples = [];
  const moves = [];
  const undo = [];
  let committed = false;
  const rename = (from, to) => {
    fs.renameSync(from, to);
    undo.push({ from, to });
  };
  try {
    for (const sourceFile of files) {
      const id = D.hash(fs.readFileSync(sourceFile));
      if (seen.has(id))
        throw new Error(
          `Duplicate raw bytes: ${sourceFile}. Resolve the duplicate before preparing.`
        );
      seen.add(id);
      const prior = previous.get(id),
        fresh = collected.get(id),
        upload = imported.get(id);
      if (prior && fresh && (prior.split !== fresh.split || prior.batchId !== fresh.batchId))
        throw new Error(`A frozen source split changed: ${id}`);
      const originalFilename =
        prior?.originalFilename ||
        fresh?.originalFilename ||
        upload?.originalFilename ||
        labels[id]?.originalFilename ||
        path.basename(sourceFile);
      const filenameLabel = D.labelFromFilename(sourceFile);
      const originalLabel = prior?.label || filenameLabel;
      const override = labels[id];
      if (
        override &&
        (!/^[1-9]{5}$/.test(override.label) ||
          !["visual-review", "user-review"].includes(override.source))
      )
        throw new Error(`Invalid independently reviewed raw label: ${id}`);
      if (
        override &&
        originalLabel &&
        override.label !== originalLabel &&
        !override.allowCorrection
      )
        throw new Error(
          `Raw label conflict for ${originalFilename}; an explicit allowCorrection is required.`
        );
      const label = override?.label || originalLabel || null;
      const labelSource =
        override?.source || prior?.labelSource || (filenameLabel ? "user-filename" : null);
      const ext = path.extname(sourceFile).toLowerCase();
      let destination;
      if (label) destination = rawDestination(root, label, ext, sourceFile);
      else destination = D.resolveInside(root, `data/review/raw/${originalFilename}`);
      // Reserve destinations before committing any raw renames.
      while (moves.some((m) => m.destination === destination)) {
        const basename = path.basename(destination, ext);
        const number = Number(basename.match(/__(\d+)$/)?.[1] || 1) + 1;
        destination = D.resolveInside(
          root,
          `data/raw/${label}__${String(number).padStart(2, "0")}${ext}`
        );
      }
      if (sourceFile !== destination) {
        if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
        moves.push({ sourceFile, destination });
      }
      const segmented = segmentRawImageFile(sourceFile, recognizer.preprocessing);
      const result = await recognizeSegments(segmented, recognizer);
      const sample = {
        id,
        originalFilename,
        rawPath: D.relative(root, destination),
        label,
        labelSource,
        origin: prior?.origin || (fresh ? "collected" : upload ? "user-import" : "existing"),
        batchId: prior?.batchId || fresh?.batchId || upload?.batchId || null,
        split: prior?.split || fresh?.split || "train",
        selection: prior?.selection || fresh?.selection || null,
        ...(upload ? { importSourceFiles: upload.sourceFiles } : {}),
        prediction: result.text,
        segmentationQuality: result.segmentationQuality,
        digits: []
      };
      for (const digit of result.digits) {
        const segment = segmented.segments[digit.index];
        const inputHash = D.hash(Buffer.from(segment.input));
        const key = `${id}_${digit.index}`;
        const decision = D.classificationDecision({
          confidence: digit.confidence,
          predictedLabel: digit.label,
          expectedLabel: label?.[digit.index],
          qualityValid: segmented.quality.valid,
          approval: approvals[key],
          inputHash
        });
        const filename = `${label || "unconfirmed"}__${id.slice(0, 12)}_${digit.index}.png`;
        const relative =
          decision.status === "review"
            ? `data/review/digits/${filename}`
            : `data/segmented/${decision.label}/${filename}`;
        const stageFile =
          decision.status === "review"
            ? path.join(stage, "review-digits", filename)
            : path.join(stage, "segmented", decision.label, filename);
        writeNormalizedPng(segment.input, recognizer.preprocessing.imageSize, stageFile);
        sample.digits.push({
          index: digit.index,
          predictedLabel: digit.label,
          confidence: digit.confidence,
          ...decision,
          path: relative,
          bbox: digit.bbox,
          inputHash,
          normalized: true
        });
      }
      samples.push(sample);
    }
    for (const id of collected.keys())
      if (!seen.has(id)) throw new Error(`A collected source is missing: ${id}`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = D.resolveInside(root, `backups/prepare-${timestamp}`);
    ensureDir(archive);
    for (const [targetRelative, stageRelative, archiveName] of [
      ["data/segmented", "segmented", "segmented"],
      ["data/review/digits", "review-digits", "review-digits"]
    ]) {
      const target = D.resolveInside(root, targetRelative);
      ensureDir(path.dirname(target));
      if (fs.existsSync(target))
        rename(target, D.resolveInside(root, `backups/prepare-${timestamp}/${archiveName}`));
      rename(path.join(stage, stageRelative), target);
    }
    for (const move of moves) {
      ensureDir(path.dirname(move.destination));
      rename(move.sourceFile, move.destination);
    }
    fs.rmdirSync(stage); // Empty only; never recursively delete a computed path.
    for (const label of D.LABELS)
      ensureDir(D.resolveInside(root, `data/review/confirmed/${label}`));
    const digits = samples.flatMap((s) => s.digits);
    const manifest = {
      version: 2,
      seed: 42,
      createdAt: old.createdAt || timestamp,
      updatedAt: new Date().toISOString(),
      labelerModel: { path: "models/labeler-baseline", sha256: fingerprint },
      preprocessingSha256: D.hash(
        fs.readFileSync(path.join(__dirname, "../src/preprocess-core.js"))
      ),
      summary: {
        rawImages: samples.length,
        confirmedRawImages: samples.filter((s) => s.label).length,
        collectedImages: samples.filter((s) => s.origin === "collected").length,
        totalDigits: digits.length,
        acceptedDigits: digits.filter((d) => d.status !== "review").length,
        reviewDigits: digits.filter((d) => d.status === "review").length,
        invalidImages: samples.filter((s) => !s.segmentationQuality.valid).length
      },
      samples
    };
    D.writeJson(manifestPath, manifest);
    committed = true;
    D.renderReview(root, manifest);
    console.log(JSON.stringify(manifest.summary, null, 2));
    return manifest;
  } catch (error) {
    if (!committed) {
      try {
        for (const move of undo.reverse()) {
          ensureDir(path.dirname(move.from));
          fs.renameSync(move.to, move.from);
        }
        const cleanup = D.resolveInside(root, "data/.prepare-stage");
        if (cleanup !== stage) throw new Error("Staging path changed.");
        if (fs.existsSync(cleanup)) fs.rmSync(cleanup, { recursive: true });
      } catch (rollbackError) {
        error.message += `; rollback needs inspection: ${rollbackError.message}`;
      }
    }
    throw error;
  }
}

if (require.main === module)
  prepare().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { prepare, rawDestination };
