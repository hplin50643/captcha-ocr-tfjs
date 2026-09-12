# 更新紀錄

## 維護整理（2026-09-12）

- README 依實作說明影像處理、切割、MLP 架構、訓練與信心判定。
- 共用專案設定、標籤及亂數／洗牌實作，保留原圖固定分組。
- 核心測試可在獨立儲存庫執行；擴充套件測試改為 `test:extension`。
- 擴充套件位置可透過 `CAPTCHA_EXTENSION_DIR` 設定。
- 修正自訂 manifest 訓練資料的路徑，以資料所在專案為基準。
- 統一 npm 鎖定安裝、Prettier、EditorConfig 與 CI；測試 Windows／Linux、Node.js 22／24。
- 歷史文件與特定批次報告工具分開存放；產生報告不再覆寫歷史 Markdown。
- 保留整理前的模型、前處理與資料位元組，未重新訓練。

## 1.2.0（2026-09-12）

- 補入 100 張低信心原圖及 8 張不同的使用者原圖，累計 333 張／1,665 字。
- 固定原圖分組、人工確認與指紋驗證；微調 Dense 模型並依驗證損失選擇權重。
- 新舊兩組保留測試各為 20/20；詳見 [實驗紀錄](docs/history/hard-example-training.md)。

## 早期版本

- 建立 TensorFlow.js 訓練、模型匯出、單張與批次推論。
- [資料擴充紀錄](docs/history/2026-09-12-results.md)。
- [斷開筆畫與邊界雜訊修正](docs/history/detached-stroke-fix.md)。
