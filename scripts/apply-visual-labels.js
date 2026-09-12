const fs = require("fs");
const path = require("path");
const D = require("../src/dataset");
const U = require("../src/image-utils");

// This command imports an explicit transcription after inspection of the sheets.
// It never creates a transcription from the model prediction.
function applyVisualLabels(batchId) {
  if (!batchId || !/^[a-zA-Z0-9_-]+$/.test(batchId)) throw new Error("Invalid batch.");
  const dir = path.join(D.ROOT, `reports/hard-examples/${batchId}`);
  const index = D.readJson(path.join(dir, "index.json"));
  const transcriptions = D.readJson(path.join(dir, "transcriptions.json"));
  if (!index || !transcriptions)
    throw new Error("Render sheets and independently transcribe them first.");
  const labels = D.readJson(path.join(D.ROOT, "data/raw-labels.json"), {});
  const approvals = D.readJson(path.join(D.ROOT, "data/review/approvals.json"), {});
  const audit = D.readJson(path.join(D.ROOT, "reports/hard-examples/visual-review.json"), {});
  const current = new Map(
    D.readJson(path.join(D.ROOT, "data/manifest.json"), { samples: [] }).samples.map((s) => [
      s.id,
      s
    ])
  );
  const actions = [];
  for (const [number, review] of Object.entries(transcriptions)) {
    const source = index.find((s) => s.number === Number(number));
    if (!source || !/^[1-9]{5}$/.test(review.label) || review.rawReviewed !== true)
      throw new Error(`Missing independent raw review: ${number}`);
    const file = D.resolveInside(D.ROOT, current.get(source.id)?.rawPath || source.file);
    if (D.hash(fs.readFileSync(file)) !== source.id)
      throw new Error(`Raw changed since review: ${number}`);
    if (labels[source.id] && labels[source.id].label !== review.label)
      throw new Error(`Existing truth conflict: ${number}`);
    const segmented = U.segmentRawImageFile(file);
    const hashes = segmented.segments.map((s) => D.hash(Buffer.from(s.input)));
    if (JSON.stringify(hashes) !== JSON.stringify(source.inputHashes))
      throw new Error(`Crops changed since review: ${number}`);
    if (review.cropsReviewed && (!segmented.quality.valid || hashes.length !== 5))
      throw new Error(`Cannot approve invalid crops: ${number}`);
    actions.push({ source, review, hashes });
  }
  for (const { source, review, hashes } of actions) {
    const reviewedAt = audit[source.id]?.reviewedAt || new Date().toISOString();
    labels[source.id] = labels[source.id] || {
      label: review.label,
      source: "visual-review",
      reviewer: "assistant-visual",
      reviewedAt,
      originalFilename: path.basename(source.file),
      batchId
    };
    audit[source.id] = {
      ...review,
      reviewer: "assistant-visual",
      inputHashes: hashes,
      sheet: `${batchId}/${source.sheet}`,
      number: source.number,
      reviewedAt
    };
    if (review.cropsReviewed)
      hashes.forEach((inputHash, i) => {
        approvals[`${source.id}_${i}`] = approvals[`${source.id}_${i}`] || {
          label: review.label[i],
          inputHash,
          reviewer: "assistant-visual",
          reviewedAt
        };
      });
  }
  D.writeJson(path.join(D.ROOT, "data/raw-labels.json"), labels);
  D.writeJson(path.join(D.ROOT, "data/review/approvals.json"), approvals);
  D.writeJson(path.join(D.ROOT, "reports/hard-examples/visual-review.json"), audit);
  console.log(`Applied ${actions.length} independently reviewed transcriptions.`);
}
if (require.main === module) {
  try {
    applyVisualLabels(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { applyVisualLabels };
