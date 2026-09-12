# 維護指南

## 模組責任

| 位置                          | 責任／修改時機                                 |
| ----------------------------- | ---------------------------------------------- |
| `src/config.js`               | 專案根目錄、標籤順序、擴充套件路徑             |
| `src/preprocess-core.js`      | 純像素前處理與切割；同時供 Node.js／瀏覽器使用 |
| `src/image-utils.js`          | PNG/JPEG 解碼、檔案搜尋、正規化圖片讀寫        |
| `src/ocr.js`                  | 載入辨識器、批次推論、組合答案與信心分數       |
| `src/tfjs-io.js`、`src/tf.js` | TensorFlow.js 模型序列化與執行環境             |
| `src/dataset.js`              | 原圖指紋、標籤、分組、人工確認規則與清單       |
| `src/random.js`               | 共用 Mulberry32 亂數及 Fisher–Yates 洗牌       |
| `scripts/`                    | CLI 參數、檔案流程與報告產生                   |
| `scripts/history/`            | 特定實驗的工具，不當作一般資料處理入口         |

新增程式優先沿用共用模組，避免讓 CLI 各自維護不同的標籤順序或分組方法。`src/dataset.js` 仍匯出 `ROOT`、`LABELS`，保留既有呼叫介面。

## 安裝與格式

使用 npm 與 `package-lock.json`。新環境執行 `npm ci`；新增／修改依賴時執行 `npm install`，並一起提交 `package.json` 與鎖定檔。本次整理已統一套件管理方式，勿再提交其他套件管理器的鎖定檔。

```bash
npm run format
npm run verify
```

`.editorconfig` 與 `.gitattributes` 規範 UTF-8、兩空白縮排及 LF；Prettier 排除資料、模型、vendor、報告、備份，以及 `src/preprocess-core.js`。

**共用前處理的原始位元組本身是收集紀錄的 SHA-256 指紋。** 不應只為格式化更動此檔；`.gitattributes` 也保留它與模型檔的原始位元組。若確實改變演算法，使用新批次重新篩選，舊批次只保留來源紀錄，不可偽造新指紋讓舊批次續傳。

一般安裝使用正式 npm 依賴。特殊環境可設定 `CODEX_NODE_MODULES` 供圖片套件載入；缺少 `@tensorflow/tfjs` 時有 `vendor/tf.min.js` 備援。CI 一律由 `npm ci` 安裝，驗證獨立安裝能力。

## 修改前處理

1. 在 `test/fixtures/` 加入可重現問題的圖片及已確認答案，於核心測試加入對應行為斷言。
2. 修改 `src/preprocess-core.js`，執行 `npm run verify`。測試包含斷開筆畫、邊界雜訊、空白圖、黏連字、99% 邊界、資料指紋、原圖分組、Node／瀏覽器一致性與 tensor 釋放。
3. 執行 `npm run prepare-data`，檢查重新切割與待確認資料。既有人工確認只有指紋一致才會沿用。
4. 按訓練、評估流程產生候選；檢查結果後才執行 `npm run evaluate -- --promote`。
5. 如有擴充套件，執行 `npm run sync:extension` 與 `npm run test:extension`，再於瀏覽器重新載入擴充套件。

前處理修改會改變模型輸入；不可只更新瀏覽器的複本或只比較平均信心。

## 核心與擴充套件測試

`npm test` 只依賴此儲存庫，包含 smoke test 與核心／資料流程測試。收集流程的網路請求由測試替身提供，不會在 CI 對網站收集驗證碼。

`npm run test:extension` 是明確選擇的整合測試，檢查前處理原始碼一致、原生 Dense 推論機率與 TensorFlow.js 一致，以及 95% 顏色提示邊界、低信心候選填入與手動輸入保護。需有完整且已同步的擴充套件目錄；缺少時會失敗並指出缺檔。

擴充套件預設為同層 `admis-captcha-extension/`。指定其他路徑：

```powershell
# PowerShell
$env:CAPTCHA_EXTENSION_DIR = 'C:\projects\admis-captcha-extension'
npm run sync:extension
npm run test:extension
```

```bash
# Linux / macOS
export CAPTCHA_EXTENSION_DIR=/path/to/admis-captcha-extension
npm run sync:extension
npm run test:extension
```

## 提交內容

提交程式、文件、測試圖片、`data/raw/`、正式／待審切割圖、manifest、原圖標籤、永久 approvals、來源批次紀錄，以及完整模型目錄。保留 `models/labeler-baseline/` 可重現分類與困難樣本篩選。

`reports/`、`backups/`、暫存檔、人工搬移中的 `data/review/confirmed/` 與可重新產生的 review HTML／pending 清單不進 Git。正式人工確認應先透過 `review:import` 匯入，再提交資料與 approvals。

需要保存實驗結論時，將精簡紀錄與必要圖片存入 `docs/history/`、`docs/assets/`。報告產生器只應寫 `reports/`，避免重跑命令覆寫人工維護的 README 或歷史文件。

模型更新須一起提交 `model.json`、`.bin`、`labels.json`、`preprocessing.json`；候選未通過時，保留部署模型。提交前執行 `git diff --check`、`npm run verify`，並檢查模型／資料更新是否符合預期。

## 常見問題

| 現象                                   | 處理                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `Cannot load package`                  | 在儲存庫根目錄執行 `npm ci`                                                  |
| 單獨 clone 後沒有 reports 或 review 頁 | 分別執行 `npm run predict`、`npm run prepare-data`                           |
| `Candidate ...` 或缺少比較／訓練報告   | 先 `npm run train`，再 `npm run evaluate`；歷史 report:hard 另需指定批次資料 |
| `Starting model`／圖片尺寸不符         | 檢查是否混用模型檔；此專案預設 32×32、九類標籤                               |
| 原圖名稱答案衝突                       | 在 `data/raw-labels.json` 記錄獨立確認，必要時指定 `allowCorrection: true`   |
| 收集續傳指紋不符                       | 還原該批原本前處理／模型，或另建新批次                                       |

自訂訓練資料若有 `data/manifest.json`，其中圖片路徑須相對於該份資料的專案根目錄。無 manifest 的舊式資料夾採逐字分組，不能當作同原圖完全隔離的測試結果。
