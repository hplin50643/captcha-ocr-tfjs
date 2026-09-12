// Historical batch report; writes generated output only under reports/.
const fs = require("fs");
const path = require("path");
const D = require("../../src/dataset");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
const pct = (v) => `${(100 * v).toFixed(2)}%`;

function reportHardExamples() {
  const manifest = D.readJson(path.join(D.ROOT, "data/manifest.json"));
  const comparison = D.readJson(path.join(D.ROOT, "reports/model-comparison/comparison.json"));
  const training = D.readJson(path.join(D.ROOT, "reports/training/metrics.json"));
  const batch = D.readJson(path.join(D.ROOT, "data/collections/hard-20260912.json"));
  const uploads = D.readJson(path.join(D.ROOT, "data/imports/user-captcha-20260912.json"));
  if (
    batch.status !== "complete" ||
    batch.entries.length !== 100 ||
    batch.entries.some((e) => !(e.minConfidence < 0.99))
  )
    throw new Error("The 100-image hard collection is not complete.");
  const before = comparison.baseline,
    candidate = comparison.candidate,
    after = comparison.decision.eligible ? candidate : before;
  if (manifest.summary.rawImages !== before.records.length) throw new Error("Comparison is stale.");
  const groupNames = {
    userImports: "使用者圖片（訓練資料）",
    hardTrain: "新增困難圖片：訓練",
    hardValidation: "新增困難圖片：驗證",
    hardTest: "新增困難圖片：獨立測試",
    legacyTest: "原有隨機組：獨立測試",
    legacy225: "原有 225 張回歸資料",
    all: "全部資料（含訓練）"
  };
  const groups = Object.entries(groupNames).map(([key, label]) => ({
    key,
    label,
    before: before[key],
    after: after[key]
  }));
  const summary = {
    generatedAt: new Date().toISOString(),
    rawImages: manifest.summary.rawImages,
    acceptedDigits: manifest.summary.acceptedDigits,
    reviewDigits: manifest.summary.reviewDigits,
    collection: {
      attempts: batch.attempts,
      retained: batch.entries.length,
      threshold: batch.threshold,
      minimumObserved: Math.min(...batch.entries.map((e) => e.minConfidence)),
      maximumObserved: Math.max(...batch.entries.map((e) => e.minConfidence)),
      modelSha256: batch.modelSha256
    },
    uploads: {
      files: uploads.entries.reduce((n, e) => n + e.sourceFiles.length, 0),
      unique: uploads.entries.length,
      duplicateResolution: "51189.png has identical bytes to 12656.png; visible answer 12656."
    },
    selected: comparison.decision.selected,
    decision: comparison.decision,
    selectedEpoch: training.selectedEpoch,
    groups
  };
  const reportDir = path.join(D.ROOT, "reports/hard-examples");
  D.writeJson(path.join(reportDir, "summary.json"), summary);
  const url = (p) =>
    D.relative(reportDir, path.join(D.ROOT, p)).split("/").map(encodeURIComponent).join("/");
  const bById = new Map(before.records.map((r) => [r.id, r])),
    aById = new Map(after.records.map((r) => [r.id, r]));
  const cards = manifest.samples
    .filter((s) => s.origin === "user-import" || s.selection === "minConfidence < 0.99")
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.rawPath.localeCompare(b.rawPath))
    .map((s) => {
      const b = bById.get(s.id),
        a = aById.get(s.id);
      return `<article data-review="${a.needsReview}" data-error="${a.text !== s.label}"><h2>${esc(s.label)} <small>${esc(s.split)} · ${s.origin === "user-import" ? "使用者標籤" : "獨立目視確認"}</small></h2><img class="raw" src="${url(s.rawPath)}" alt="${esc(s.label)} 原圖"><p>舊模型 <b>${esc(b.text)}</b> · 最低 ${pct(b.minConfidence)}<br>部署模型 <b>${esc(a.text)}</b> · 最低 ${pct(a.minConfidence)} · ${a.needsReview ? "仍提示人工輸入" : "可自動填入"}</p><div class="digits">${s.digits.map((d) => `<figure><img src="${url(d.path)}" alt="第 ${d.index + 1} 字 ${esc(d.label)}"><figcaption>${esc(d.label)} · ${pct(a.digits[d.index]?.confidence || 0)}</figcaption></figure>`).join("")}</div><small>${esc(s.id.slice(0, 12))} · ${esc(s.originalFilename)}</small></article>`;
    })
    .join("");
  const rows = groups
    .map(
      (g) =>
        `<tr><th>${esc(g.label)}</th>${[g.before, g.after].map((m) => `<td>${m.correctImages}/${m.images}</td><td>${m.correctDigits}/${m.digits}</td><td>${m.acceptedImages}/${m.images}</td><td>${m.acceptedImageErrors}</td>`).join("")}</tr>`
    )
    .join("");
  fs.writeFileSync(
    path.join(reportDir, "index.html"),
    `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>低信心樣本與重訓結果</title><style>body{font:16px system-ui;max-width:1160px;margin:32px auto;padding:0 20px;color:#173042;background:#f5f7fa}p{line-height:1.8}table{border-collapse:collapse;background:white;width:100%}th,td{border:1px solid #cbd5df;padding:10px}th{background:#e8eef4}article{background:white;border:1px solid #ccd6df;border-radius:10px;padding:16px}h2{font-size:21px}h2 small{font-size:13px;font-weight:400}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(450px,1fr));gap:16px}.raw{width:500px;max-width:100%;image-rendering:pixelated}.digits{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;text-align:center}figure img{width:64px;height:64px;image-rendering:pixelated}figcaption{font-size:12px}button{font:inherit;padding:8px 14px;margin:8px 5px 20px 0;cursor:pointer}article[hidden]{display:none}small{overflow-wrap:anywhere}.scroll{overflow:auto}</style><h1>低信心樣本與重訓結果</h1><p>篩選 ${batch.attempts} 張回應，保留 100 張最低字元信心 &lt; 99% 的不同原圖；逐張核對答案與切割。使用者提供 ${summary.uploads.files} 個檔案，去重後新增 ${summary.uploads.unique} 張。<code>51189.png</code> 與 <code>12656.png</code> 內容相同，正確答案為 12656。</p><p>目前 ${summary.rawImages} 張原圖、${summary.acceptedDigits} 個合格切割數字、${summary.reviewDigits} 個待確認。部署：<b>${esc(summary.selected)}</b>。微調 20 epochs，以驗證損失選出第 ${training.selectedEpoch} epoch。99% 是信心門檻；實測結果如下。</p><div class="scroll"><table><tr><th rowspan="2">資料組</th><th colspan="4">舊模型</th><th colspan="4">部署模型</th></tr><tr>${[0, 1].map(() => "<th>整張正確</th><th>逐字正確</th><th>自動填入</th><th>自動但答錯</th>").join("")}</tr>${rows}</table></div><p>新 100 張按原圖固定分為 60／20／20；舊測試組未更換。困難測試組有篩選偏差、樣本規模有限；含訓練資料的數字不能視為泛化正確率。<a href="../model-comparison/index.html">完整候選模型比較</a> · <a href="summary.json">數據紀錄</a></p><h2>本次新增原圖與切割</h2><button data-filter="all">全部</button><button data-filter="review">仍低於自動填入門檻</button><button data-filter="error">答案不符</button><div class="grid">${cards}</div><script>document.querySelectorAll('button[data-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('article').forEach(a=>{a.hidden=b.dataset.filter==='review'?a.dataset.review!=='true':b.dataset.filter==='error'?a.dataset.error!=='true':false})})</script></html>`
  );
  const mdRows = groups
    .map(
      (g) =>
        `| ${g.label} | ${g.before.correctImages}/${g.before.images} | ${g.after.correctImages}/${g.after.images} | ${g.before.acceptedImages} → ${g.after.acceptedImages} | ${g.after.acceptedImageErrors} |`
    )
    .join("\n");
  fs.writeFileSync(
    path.join(D.ROOT, "reports/hard-examples/summary.md"),
    `# 低信心樣本補強（2026-09-12）\n\n收集 ${batch.attempts} 張網站回應，保留 100 張不同原圖，收集時最低字元信心介於 ${pct(summary.collection.minimumObserved)}～${pct(summary.collection.maximumObserved)}，全部嚴格低於 99%。篩選使用固定舊模型、原圖內容雜湊去重、請求至少相隔 2 秒；未使用帳號密碼。\n\n使用者的 Captcha 目錄有 ${summary.uploads.files} 個檔案、${summary.uploads.unique} 張不同圖片。51189.png 與 12656.png 內容完全相同，目視答案為 12656，因此只加入一份正確標籤。來源檔案保持原狀。\n\n原圖答案與全部新切割圖已獨立目視核對，亦確認舊資料的 21 個待審字元。資料庫現在有 ${summary.rawImages} 張原圖、${manifest.summary.totalDigits} 個切割數字，其中 ${summary.acceptedDigits} 個合格、${summary.reviewDigits} 個待確認。判讀紀錄含原圖 SHA-256、切割 inputHash 與確認者；模型猜測不作為真實標籤。\n\n## 訓練與測試\n\n原有 225 張資料的分組固定。新增 100 張採種子 42，以原圖分為 60 張訓練、20 張驗證、20 張測試，使用者 ${summary.uploads.unique} 張供訓練。最終訓練／驗證／測試字元數為 ${training.splitSizes.train}／${training.splitSizes.validation}／${training.splitSizes.test}；同張原圖無跨組。\n\n從舊 Dense 權重微調，學習率 ${training.learningRate}，${training.epochs} epochs，以最低驗證損失選出第 ${training.selectedEpoch} epoch。測試組不參與訓練及 epoch 選擇。部署 ${summary.selected}；${comparison.decision.eligible ? "候選模型通過回歸與保留測試的正確數、99% 接受比例和接受錯誤數檢查。" : "候選模型未通過部署條件，保留舊權重。原因：" + comparison.decision.reasons.join(", ")}\n\n| 資料組 | 舊模型整張正確 | 部署模型整張正確 | 可自動填入張數 | 部署模型自動但答錯 |\n| --- | --- | --- | --- | --- |\n${mdRows}\n\n99% 是模型信心門檻，不是正確率保證。新的測試組特別挑選舊模型低信心案例，不能代表所有網站圖片；原有隨機測試組另外報告。訓練資料上的改善只代表已見樣本的擬合效果。\n\n## 檔案與使用\n\n- [圖文比較](index.html)：原圖、切割、前後答案與最低信心，可篩選仍需人工輸入的圖片。\n- [模型比較](../model-comparison/index.html)：舊模型與候選模型的逐組結果。\n- [訓練紀錄](../training/metrics.json)：權重來源、分組 ID、選用 epoch 及完整曲線。\n- [資料確認總覽](../../data/review/index.html)：仍待確認的資料。\n\n重新載入 Chrome／Edge 的 admis-captcha-extension，並重新整理登入頁，才會使用同步後的模型。仍維持每字信心均達 99%、切割有效才自動填入，保留手動輸入與圖片更換檢查。\n`
  );
  console.log(JSON.stringify(summary, null, 2));
}
if (require.main === module) {
  try {
    reportHardExamples();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { reportHardExamples };
