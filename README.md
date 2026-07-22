# US Stock IV

以 Alpaca 免費 `indicative` 選擇權資料查詢單一美股的 2 至 6 個月 Put IV，作為 FCN 條件研究工具。

## 使用方式

1. 申請 Alpaca 帳號並建立 API Key ID 與 Secret Key。
2. 開啟網站，在「Alpaca 免費 API 設定」貼上兩個金鑰。
3. 輸入美股代碼、FCN 轉換價（佔現價百分比）、無風險利率與股利殖利率。
4. 按「載入期限 IV」。

金鑰僅暫存於目前瀏覽器分頁的 `sessionStorage`，關閉分頁就會移除；不會提交到 GitHub。

## 資料限制

- 使用 Alpaca 的免費 `indicative` 選擇權 feed：資料延遲且報價可能經調整，不能作為交易或 FCN 最終報價。
- 每次查詢只讀取使用者輸入標的、2 至 6 個月到期區間的 Put 選擇權鏈；不掃描或儲存全市場資料。
- 若 API 快照未附 IV，網站會以 Put Bid/Ask 中間價、標的價格、到期日、無風險利率與股利殖利率，用 Black–Scholes 模型反推 IV。此估算未涵蓋離散股利、提前履約、流動性與發行人避險成本。

正式 FCN 報價請以發行券商提供的條件與價格補充文件為準。
