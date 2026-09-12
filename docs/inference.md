# 推論與擴充套件

```bash
npm run solve -- data/raw/14662.png
npm run predict
```

Node.js API：

```js
const { solveCaptchaFile } = require("./src/ocr");
const result = await solveCaptchaFile("data/raw/14662.png");
if (!result.needsReview) console.log(result.text);
```

| 欄位                | 說明                                          |
| ------------------- | --------------------------------------------- |
| text                | 左至右候選答案；切割異常時可能不是五位數      |
| confidence          | 平均字元信心，保留舊 API 語意                 |
| minConfidence       | 最低字元信心                                  |
| needsReview         | 任一字低於 0.99、切割無效或字數不符時為 true  |
| segmentMethod       | projection 或 projection-valley               |
| segmentationQuality | 有效性、原因、字數與移除的雜訊區塊            |
| digits              | 每字 label、confidence、bbox 及 probabilities |

空白或無法可靠切割的圖片不會強制補成五個字。批次輸出位於 reports/raw-predictions/，包含 HTML、CSV、JSON、二值化圖與數字。`42385__02.png` 可解析為 42385，報告圖片名稱另含內容雜湊，避免同名但不同副檔名互相覆蓋。

## 擴充套件 1.2.2

`npm run sync:extension` 預設使用相鄰擴充套件，也可設定 `CAPTCHA_EXTENSION_DIR` 指定目錄。`npm run test:extension` 可另行執行整合測試。同步時檢查權重規格並複製 src/preprocess-core.js 及 model/ 至相鄰擴充套件。共用前處理支援 CommonJS 及瀏覽器，不應單獨編輯套件的 src/preprocess.js。

擴充套件從已載入圖片的自然尺寸讀取像素，不另發請求取得可能已改變的驗證碼。圖片更換、相同 URL 重新載入或欄位更換時，舊推論不會填入新欄位。

切割有效且辨識出五個數字時會自動填入。五字信心均 ≥ 95% 顯示綠色；低於 95% 仍填入候選答案，並顯示黃色人工確認提示。切割異常或字數不符時顯示候選、最低信心與人工填寫提示。使用者原有輸入、推論期間輸入及刪除動作均保留；圖片更新時只清除未經使用者修改的套件舊填入內容。

擴充套件以 fill-policy 的 MIN_CONFIDENCE = 0.95 計算 needsReview 與填入決策；Node.js API 和資料整理仍使用原有 99% 門檻。

更新套件資料夾或解壓新版 ZIP 後，到 chrome://extensions/ 或 edge://extensions/ 重新載入，再重新整理登入頁。既有使用者按 Enter 登入的操作維持原有行為。
