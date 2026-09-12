const fs = require("fs");
const path = require("path");
const D = require("../src/dataset");
const { readNormalizedDigit, ensureDir, walkImageFiles } = require("../src/image-utils");

function importReviews(root = D.ROOT) {
  const manifestPath = D.resolveInside(root, "data/manifest.json");
  const manifest = D.readJson(manifestPath);
  if (!manifest) throw new Error("Run prepare-data first.");
  const approvalsPath = D.resolveInside(root, "data/review/approvals.json");
  const approvals = D.readJson(approvalsPath, {});
  const byName = new Map();
  for (const sample of manifest.samples)
    for (const digit of sample.digits) byName.set(path.basename(digit.path), { sample, digit });
  const actions = [];
  for (const label of D.LABELS)
    for (const filename of walkImageFiles(
      D.resolveInside(root, `data/review/confirmed/${label}`)
    )) {
      const match = byName.get(path.basename(filename));
      if (!match) throw new Error(`Unknown review file: ${filename}`);
      const { sample, digit } = match;
      if (!sample.segmentationQuality.valid)
        throw new Error(`Invalid segmentation requires re-segmentation: ${filename}`);
      if (!sample.label || sample.label[digit.index] !== label)
        throw new Error(`Review label conflicts with the confirmed raw answer: ${filename}`);
      const inputHash = D.hash(Buffer.from(readNormalizedDigit(filename).input));
      if (inputHash !== digit.inputHash)
        throw new Error(`Review image changed or is stale: ${filename}`);
      if (actions.some((a) => a.digit === digit))
        throw new Error(`Duplicate confirmation: ${filename}`);
      const destination = D.resolveInside(
        root,
        `data/segmented/${label}/${path.basename(filename)}`
      );
      if (
        fs.existsSync(destination) &&
        D.hash(fs.readFileSync(destination)) !== D.hash(fs.readFileSync(filename))
      )
        throw new Error(`Destination conflict: ${destination}`);
      actions.push({ filename, destination, sample, digit, label, inputHash });
    }
  // Validate the entire batch before moving any files or changing labels.
  for (const action of actions) {
    const { filename, destination, sample, digit, label, inputHash } = action;
    ensureDir(path.dirname(destination));
    if (!fs.existsSync(destination)) fs.copyFileSync(filename, destination);
    const oldPath = D.resolveInside(root, digit.path);
    if (oldPath !== destination && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    fs.unlinkSync(filename);
    Object.assign(digit, {
      label,
      status: "manual",
      reasons: [],
      path: D.relative(root, destination)
    });
    approvals[`${sample.id}_${digit.index}`] = {
      label,
      inputHash,
      reviewer: "user",
      reviewedAt: new Date().toISOString()
    };
  }
  manifest.summary.acceptedDigits = manifest.samples
    .flatMap((s) => s.digits)
    .filter((d) => d.status !== "review").length;
  manifest.summary.reviewDigits = manifest.summary.totalDigits - manifest.summary.acceptedDigits;
  manifest.updatedAt = new Date().toISOString();
  D.writeJson(approvalsPath, approvals);
  D.writeJson(manifestPath, manifest);
  D.renderReview(root, manifest);
  console.log(`Imported ${actions.length} manually confirmed digits.`);
  return actions.length;
}

if (require.main === module) {
  try {
    importReviews();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { importReviews };
