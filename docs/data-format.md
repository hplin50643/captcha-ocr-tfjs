# 資料格式與人工確認

## 原圖

data/raw/ 只存已確認的五位數原圖，支援 PNG/JPEG 及數字 1–9。`42385.png`、`42385__02.png` 的正確標籤均為 42385。解碼時會檢查圖片檔頭，改名不改動原圖位元組。

未確認原圖在 data/review/raw/。data/raw-labels.json 用原圖完整 SHA-256 作為鍵：

```json
{
  "原圖完整SHA256": {
    "label": "42385",
    "source": "user-review",
    "originalFilename": "capture_001_example.png"
  }
}
```

source 可為 user-review 或 visual-review，只用於獨立目視確認。修正已確認答案時，該項目須另加 `"allowCorrection": true`，再執行 `npm run prepare-data`。模型不能自動覆寫原有答案。

## 數字與狀態

每張切割圖片為 32×32 黑字白底 PNG，已完成置中與正規化。檔名為 `答案__原圖雜湊前12字_位置.png`，位置從左至右為 0–4。

- auto：逐字信心 ≥ 0.99、整張切割有效、原圖答案已確認且預測與答案相符。
- manual：經使用者或助理獨立目視確認後匯入，允許低信心，但仍須切割有效、圖片未變且符合原圖答案；確認者記錄在 approvals 的 reviewer 欄位。
- review：需人工確認，原因可能是 confidence-below-99、label-conflict、invalid-segmentation 或 unconfirmed-raw-label。

auto/manual 圖片在 data/segmented/1–9/，review 圖片獨立在 data/review/digits/。manifest 記錄原圖 id、originalFilename、rawPath、label、labelSource、origin、split、segmentationQuality 及 digits；每字有 path、index、predictedLabel、confidence、status、reasons、bbox 與 inputHash。

## 人工確認

1. 開啟 data/review/index.html 查看原圖與待確認數字。
2. 把確認完成的 PNG 移到 data/review/confirmed/正確數字/，不要改檔名。
3. 執行 `npm run review:import`。

匯入前會驗證整批檔案。未知檔名、被修改的圖片、答案衝突或切割異常會使該批驗證失敗，保留檔案。成功確認記錄在 data/review/approvals.json，重跑整理時依原圖 ID、位置及內容指紋沿用。

若切割錯誤，先修正切割再重跑 prepare-data；不能只把錯切的圖放入分類。若原圖答案錯誤，先更正 raw-labels.json。

## 備份與中斷

prepare-data 先在 data/.prepare-stage/ 完成切割，保存前版至 backups/prepare-\*/ 再替換正式目錄。可預期的執行錯誤會回復已搬動的檔案。若電腦中斷後留下暫存目錄，先檢查暫存目錄及備份，不要直接刪除原圖。

collection.json 保存本次 100 張擷取進度，未使用登入帳號或密碼。manifest 保存目前原圖路徑；collection 的 path 則是下載當時的位置。

## 多批次與使用者上傳

`data/collection.json` 保留第一批隨機收集紀錄；`data/collections/<batch>.json` 保存後續批次。困難樣本批次包含固定篩選模型與前處理指紋、嚴格 `< 0.99` 門檻、每張原圖的最低信心及所有字元分數、請求次數、去重雜湊與中斷續傳狀態。未滿額批次不能分配正式訓練／驗證／測試組。

`data/imports/<batch>.json` 記錄從 `Captcha` 匯入的原檔名及內容對應。匯入保留來源檔案，相同內容只收一份。如果相同圖片出現不同答案檔名，整批先拒絕寫入，直到提供有理由的獨立確認紀錄。這次的 `51189.png` 與 `12656.png` 位元組相同，目視確認為 `12656`，解決紀錄在 `data/import-resolutions.json`。

```bash
npm run import:raw -- --dir=../Captcha --batch=user-captcha-20260912 --resolutions=data/import-resolutions.json
npm run collect:hard -- --batch=hard-20260912 --count=100
npm run labeling:sheets -- hard-20260912
```

收集使用獨立連線工作階段，所有請求開始時間至少相隔 2 秒。遇 HTTP 錯誤、拒絕存取或非圖片回應即停止，不重試；原始內容不修改。相同指令可在檢查停止原因後續傳，已完成批次不再下載。要建立另一批，指定新的 batch 名稱。預設最多篩選 5,000 次，未達 100 張會保留缺額紀錄。

`reports/hard-examples/<batch>/sheet-*.png` 並列原圖與切割圖，不顯示模型答案，供獨立判讀。實際判讀後才填寫 `transcriptions.json` 的 `label`、`rawReviewed`、`cropsReviewed`；`npm run labeling:apply -- <batch>` 會核對原圖雜湊與當時切割圖指紋，再匯入判讀紀錄。不能用模型預測自動產生這份檔案。切割無效時只確認原圖，不可將 cropsReviewed 設為 true。
