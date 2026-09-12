const fs = require("fs");
const path = require("path");
const D = require("../src/dataset");
const { solveCaptchaFile } = require("../src/ocr");

function metrics(records) {
  let correctDigits = 0,
    accepted = 0,
    acceptedErrors = 0,
    acceptedDigits = 0,
    acceptedDigitErrors = 0;
  for (const r of records) {
    for (let i = 0; i < r.expected.length; i++) if (r.text[i] === r.expected[i]) correctDigits++;
    for (const digit of r.digits)
      if (r.segmentationQuality.valid && digit.confidence >= 0.99) {
        acceptedDigits++;
        if (digit.label !== r.expected[digit.index]) acceptedDigitErrors++;
      }
    if (!r.needsReview) {
      accepted++;
      if (r.text !== r.expected) acceptedErrors++;
    }
  }
  const correct = records.filter((r) => r.text === r.expected).length;
  return {
    images: records.length,
    correctImages: correct,
    imageAccuracy: records.length ? correct / records.length : null,
    digits: records.length * 5,
    correctDigits,
    digitAccuracy: records.length ? correctDigits / (records.length * 5) : null,
    acceptedImages: accepted,
    autoAcceptRate: records.length ? accepted / records.length : null,
    acceptedImageErrors: acceptedErrors,
    acceptedDigits,
    acceptedDigitErrors
  };
}

async function evaluate(modelRelative, manifest) {
  const records = [];
  for (const sample of manifest.samples) {
    if (!sample.label) continue;
    const result = await solveCaptchaFile(D.resolveInside(D.ROOT, sample.rawPath), {
      modelDir: D.resolveInside(D.ROOT, modelRelative)
    });
    records.push({
      id: sample.id,
      file: sample.rawPath,
      expected: sample.label,
      origin: sample.origin,
      split: sample.split,
      batchId: sample.batchId,
      selection: sample.selection,
      labelSource: sample.labelSource,
      ...result
    });
  }
  const screenshot = await solveCaptchaFile(
    path.join(D.ROOT, "test/fixtures/42385-edge-noise.png"),
    { modelDir: path.join(D.ROOT, modelRelative) }
  );
  const frozenIds = new Set(
    D.readJson(path.join(D.ROOT, "data/regression-sources.json"), { sources: [] }).sources.map(
      (s) => s.id
    )
  );
  const hard = records.filter((r) => r.selection === "minConfidence < 0.99");
  return {
    model: modelRelative,
    sha256: D.modelFingerprint(path.join(D.ROOT, modelRelative)),
    all: metrics(records),
    existing: metrics(records.filter((r) => r.origin === "existing")),
    user25: metrics(records.filter((r) => r.labelSource === "user-filename")),
    validation: metrics(records.filter((r) => r.split === "validation")),
    test: metrics(records.filter((r) => r.split === "test")),
    legacy225: metrics(records.filter((r) => frozenIds.has(r.id))),
    legacyTest: metrics(records.filter((r) => frozenIds.has(r.id) && r.split === "test")),
    userImports: metrics(records.filter((r) => r.origin === "user-import")),
    hardAll: metrics(hard),
    hardTrain: metrics(hard.filter((r) => r.split === "train")),
    hardValidation: metrics(hard.filter((r) => r.split === "validation")),
    hardTest: metrics(hard.filter((r) => r.split === "test")),
    screenshot: {
      expected: "42385",
      text: screenshot.text,
      needsReview: screenshot.needsReview,
      minConfidence: screenshot.minConfidence,
      quality: screenshot.segmentationQuality
    },
    errors: records.filter((r) => r.text !== r.expected),
    records
  };
}

async function main() {
  const manifest = D.readJson(path.join(D.ROOT, "data/manifest.json"));
  if (!manifest || manifest.samples.some((s) => !s.label))
    throw new Error("Independently confirm all raw labels before model comparison.");
  const baseline = await evaluate("models/labeler-baseline", manifest);
  const candidate = await evaluate("models/candidate", manifest);
  const reasons = [];
  for (const group of ["user25", "existing", "legacy225", "legacyTest", "hardTest", "test"]) {
    if (
      candidate[group].correctImages < baseline[group].correctImages ||
      candidate[group].correctDigits < baseline[group].correctDigits
    )
      reasons.push(`${group}-accuracy-regressed`);
    if (
      candidate[group].acceptedImageErrors > baseline[group].acceptedImageErrors ||
      candidate[group].acceptedDigitErrors > baseline[group].acceptedDigitErrors
    )
      reasons.push(`${group}-high-confidence-errors-increased`);
    if (candidate[group].acceptedImages < baseline[group].acceptedImages)
      reasons.push(`${group}-auto-accept-coverage-regressed`);
  }
  if (candidate.user25.correctImages !== candidate.user25.images)
    reasons.push("user-label-regression");
  if (candidate.screenshot.text !== "42385" || !candidate.screenshot.quality.valid)
    reasons.push("screenshot-regression");
  for (const label of ["22329", "21629", "21652", "22873"]) {
    const result = candidate.records.find((r) => r.expected === label);
    if (!result || result.text !== label || result.digits[0].confidence < 0.99)
      reasons.push(`clipped-2-regression-${label}`);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: manifest.summary,
    splitPolicy:
      "Original splits frozen. Each independently labeled collection batch = 60 train / 20 validation / 20 test (seed 42). User uploads = train. Hard-example holdout is a targeted low-confidence distribution, reported separately from original random holdout.",
    decision: {
      eligible: reasons.length === 0,
      selected: reasons.length ? "baseline" : "candidate",
      reasons
    },
    baseline,
    candidate
  };
  const reportDir = path.join(D.ROOT, "reports", "model-comparison");
  fs.mkdirSync(reportDir, { recursive: true });
  D.writeJson(path.join(reportDir, "comparison.json"), report);
  const rows = [
    "all",
    "legacy225",
    "user25",
    "userImports",
    "hardAll",
    "hardTrain",
    "hardValidation",
    "hardTest",
    "legacyTest",
    "validation",
    "test"
  ]
    .map(
      (group) =>
        `<tr><th>${group}</th>${[baseline, candidate]
          .map((model) => {
            const m = model[group];
            return `<td>${m.correctImages}/${m.images}</td><td>${m.correctDigits}/${m.digits}</td><td>${m.acceptedImages}/${m.images}</td><td>${m.acceptedImageErrors}</td>`;
          })
          .join("")}</tr>`
    )
    .join("");
  fs.writeFileSync(
    path.join(reportDir, "index.html"),
    `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>模型比較</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#173042}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd8e2;padding:12px}th{background:#eaf0f6}code{background:#eee;padding:3px}p{line-height:1.7}</style><h1>驗證碼模型比較</h1><p>選用：<b>${report.decision.selected}</b>。${reasons.length ? reasons.join(", ") : "通過原資料、25 張人工標籤、截圖與保留測試組檢查。"}</p><p>Baseline 與 candidate 均使用修正後的共用切割。每批新資料按原圖分為 60/20/20；hardTest 是低信心篩選組，legacyTest 是原有隨機組，兩組皆未參與訓練。其餘含訓練資料的結果屬描述性或回歸檢查。99% 代表信心門檻。</p><table><tr><th rowspan="2">資料組</th><th colspan="4">Baseline</th><th colspan="4">Candidate</th></tr><tr>${[1, 2].map(() => "<th>整張正確</th><th>數字正確</th><th>自動接受</th><th>接受但錯誤</th>").join("")}</tr>${rows}</table><p>截圖：baseline <code>${baseline.screenshot.text}</code>，candidate <code>${candidate.screenshot.text}</code>。</p><p>各組測試圖數量有限，低信心篩選組亦有取樣偏差；本次結果不代表所有未來圖片的正確率。</p><p>完整逐字分數與錯誤原圖：<a href="comparison.json">comparison.json</a></p></html>`
  );
  console.log(
    JSON.stringify(
      {
        decision: report.decision,
        baseline: { all: baseline.all, test: baseline.test, screenshot: baseline.screenshot },
        candidate: { all: candidate.all, test: candidate.test, screenshot: candidate.screenshot }
      },
      null,
      2
    )
  );
  if (process.argv.includes("--promote")) {
    const destination = D.resolveInside(D.ROOT, "model");
    if (report.decision.eligible) {
      const archive = D.resolveInside(D.ROOT, `backups/model-${Date.now()}`);
      if (fs.existsSync(destination)) fs.cpSync(destination, archive, { recursive: true });
      fs.cpSync(D.resolveInside(D.ROOT, "models/candidate"), destination, { recursive: true });
    }
    D.writeJson(path.join(reportDir, "deployment.json"), {
      selected: report.decision.selected,
      sha256: D.modelFingerprint(destination),
      deployedAt: new Date().toISOString()
    });
    console.log(
      report.decision.eligible
        ? "Deployed candidate model."
        : "Candidate rejected; deployed weights retained."
    );
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { metrics, evaluate };
