const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDir } = require("./image-utils");

const { ROOT, LABELS } = require("./config");
const { mulberry32, shuffleInPlace } = require("./random");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function resolveInside(root, relative) {
  const base = path.resolve(root),
    target = path.resolve(base, relative);
  if (target === base || !target.startsWith(base + path.sep))
    throw new Error(`Path must stay inside ${base}: ${relative}`);
  return target;
}
function relative(root, filename) {
  return path.relative(root, filename).split(path.sep).join("/");
}
function readJson(filename, fallback = null) {
  return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : fallback;
}
function writeJson(filename, value) {
  ensureDir(path.dirname(filename));
  fs.writeFileSync(`${filename}.tmp`, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(`${filename}.tmp`, filename);
}
function labelFromFilename(filename) {
  return (
    path.basename(filename, path.extname(filename)).match(/^([1-9]{5})(?:__\d{2,})?$/)?.[1] || null
  );
}
function splitCollected(ids, seed = 42) {
  const shuffled = [...ids].sort();
  shuffleInPlace(shuffled, mulberry32(seed));
  const trainEnd = Math.floor(shuffled.length * 0.6),
    validationEnd = trainEnd + Math.floor(shuffled.length * 0.2);
  return Object.fromEntries(
    shuffled.map((id, i) => [
      id,
      i < trainEnd ? "train" : i < validationEnd ? "validation" : "test"
    ])
  );
}
function sourceBatches(root) {
  const legacy = readJson(resolveInside(root, "data/collection.json"));
  const collectionsDir = resolveInside(root, "data/collections");
  const importsDir = resolveInside(root, "data/imports");
  const readDir = (dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => readJson(path.join(dir, f)))
      : [];
  return {
    collections: [...(legacy ? [legacy] : []), ...readDir(collectionsDir)],
    imports: readDir(importsDir)
  };
}
function classificationDecision({
  confidence,
  predictedLabel,
  expectedLabel,
  qualityValid,
  approval,
  inputHash
}) {
  const reasons = [];
  if (!qualityValid) reasons.push("invalid-segmentation");
  if (!expectedLabel) reasons.push("unconfirmed-raw-label");
  if (
    approval &&
    qualityValid &&
    approval.inputHash === inputHash &&
    approval.label === expectedLabel
  )
    return { status: "manual", label: expectedLabel, reasons: [] };
  if (!Number.isFinite(confidence) || confidence < 0.99) reasons.push("confidence-below-99");
  if (expectedLabel && predictedLabel !== expectedLabel) reasons.push("label-conflict");
  return {
    status: reasons.length ? "review" : "auto",
    label: expectedLabel || predictedLabel,
    reasons
  };
}
function modelFingerprint(modelDir) {
  const files = fs
    .readdirSync(modelDir)
    .filter((f) => /\.(json|bin)$/.test(f))
    .sort();
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(file);
    digest.update(fs.readFileSync(path.join(modelDir, file)));
  }
  return digest.digest("hex");
}
function html(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
function renderReview(root, manifest) {
  const report = path.join(root, "data", "review", "index.html");
  const imageUrl = (p) =>
    relative(path.dirname(report), resolveInside(root, p))
      .split("/")
      .map(encodeURIComponent)
      .join("/");
  const pending = manifest.samples.filter(
    (s) => !s.label || s.digits.some((d) => d.status === "review")
  );
  const rows = pending
    .map(
      (
        sample
      ) => `<article><h2>${html(sample.originalFilename)} · 正確答案：${html(sample.label || "待確認")}</h2>
    <img class="raw" src="${html(imageUrl(sample.rawPath))}" alt="原始驗證碼"><p>模型：${html(sample.prediction)} · ${html(sample.id.slice(0, 12))} · ${html(sample.split)}</p>
    <div class="digits">${sample.digits.map((d) => `<section class="${d.status}"><img src="${html(imageUrl(d.path))}" alt="第 ${d.index + 1} 字"><b>第 ${d.index + 1} 字：${html(d.predictedLabel)}</b><span>信心 ${(d.confidence * 100).toFixed(3)}%</span><span>正確標籤 ${html(sample.label?.[d.index] || "待確認")}</span><span>${html(d.reasons.join(", ") || d.status)}</span><code>${html(path.basename(d.path))}</code></section>`).join("")}</div></article>`
    )
    .join("\n");
  ensureDir(path.dirname(report));
  fs.writeFileSync(
    report,
    `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>驗證碼人工確認</title><style>
    body{font:16px system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#173042;background:#f3f6f8}h1{font-size:28px}article{background:white;border:1px solid #d5dfe7;border-radius:12px;padding:20px;margin:20px 0}h2{font-size:18px}.raw{max-width:100%;width:500px;image-rendering:pixelated}.digits{display:flex;flex-wrap:wrap;gap:12px}section{display:flex;flex-direction:column;gap:8px;padding:12px;background:#edf6ee;max-width:190px}section.review{background:#fff0d9}section img{width:80px;height:80px;image-rendering:pixelated}code{font-size:10px;overflow-wrap:anywhere}p{line-height:1.7}
    </style><h1>驗證碼人工確認</h1><p>${pending.length} 張原圖含待確認項目；${manifest.summary.reviewDigits} 個數字待確認。百分比是模型信心分數。</p>
    <p>確認數字後，將 <code>digits/</code> 中的 PNG 移至 <code>confirmed/1/</code> 至 <code>confirmed/9/</code>，再執行 <code>npm run review:import</code>。保留完整檔名。切割無效、原圖未確認或與原圖答案不符時，匯入會拒絕並說明原因。</p>
    <p>原圖答案修改：編輯 <code>data/raw-labels.json</code> 的對應 SHA-256 項目，填入 <code>{"label":"42385","source":"user-review"}</code>，再執行 <code>npm run prepare-data</code>。已確認檔名的衝突修改另須設定 <code>allowCorrection:true</code>。</p>${rows || "<p>目前沒有待確認樣本。</p>"}</html>`
  );
  writeJson(
    path.join(root, "data", "review", "pending.json"),
    pending.map((s) => ({
      id: s.id,
      originalFilename: s.originalFilename,
      rawPath: s.rawPath,
      label: s.label,
      digits: s.digits.filter((d) => d.status === "review")
    }))
  );
}

module.exports = {
  ROOT,
  LABELS,
  hash,
  resolveInside,
  relative,
  readJson,
  writeJson,
  labelFromFilename,
  splitCollected,
  sourceBatches,
  classificationDecision,
  modelFingerprint,
  renderReview
};
