# 訓練與模型選擇

```bash
npm run train
npm run evaluate
npm run evaluate -- --promote
npm run sync:extension
```

## 資料分組

預設讀取 `data/manifest.json`，同一張原圖的所有字元只屬於同一組。原有 225 張的分組固定保存在 `data/regression-sources.json`。原有 125 張供訓練；每一批新收集的 100 張分別以種子 42 分為 60 張訓練、20 張驗證、20 張測試。加入新批次不會重新洗牌舊資料。使用者提供的 `Captcha` 圖片去重後放入訓練組。

低信心篩選的測試組反映「舊模型較困難的圖片」，與原先隨機收集的測試組分開報告。驗證組選 epoch；測試組不參與訓練或 epoch 選擇。最新資料數量與結果見 [低信心樣本報告](history/hard-example-training.md)。

訓練只讀 `auto`、`manual` 狀態的數字。低於 99% 但已獨立確認答案、切割完整且內容指紋相符的數字，可以經確認後成為 `manual`，用於補強模型。未確認或切割無效的數字不會混入訓練。驗證和測試可使用已確認原圖答案的低信心數字。

32×32 PNG 直接還原黑白像素，不再次二值化、裁切或縮放。自訂 `--data-dir` 若沒有 manifest，仍支援舊式逐類別分組；該結果不能當作原圖隔離的評估。

## 模型與選擇

保留 32×32 → Flatten → Dense(128,relu) → Dropout(0.25) → Dense(64,relu) → Dense(9,softmax)。Dense 權重名稱與擴充套件的 JavaScript 推論器相容。

預設從 `models/labeler-baseline` 的權重微調，Adam 學習率 0.0001、最多 20 epochs、batch size 32、種子 42。保存驗證損失最低的 epoch；記錄起始權重 SHA-256、完整訓練曲線及各組原圖 ID。候選輸出不可覆寫起始模型。

```bash
npm run train -- --from-model=models/labeler-baseline --learning-rate=0.0001 --epochs=20
# 若要從隨機初始權重重新訓練：
npm run train -- --from-model=none --learning-rate=0.001
```

候選模型在 `models/candidate/`，報告在 `reports/training/`。`evaluate` 比較整張及逐字正確數、99% 接受比例和接受但答錯數，包含舊資料、新困難樣本、使用者圖片及兩組獨立測試資料。

`--promote` 僅在原有標籤、回歸資料、各保留測試組的正確數、接受錯誤數和接受比例均未退步，且 `42385` 截圖與裁切 `2` 案例通過時才替換部署權重。否則保留已部署模型。替換前備份至 `backups/model-*/`。

`models/labeler-baseline/` 固定用於資料分類與困難樣本篩選；重新訓練不會改寫它。模型信心超過 99% 不等於實測正確率達到 99%。
