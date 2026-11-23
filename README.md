<p align="center">
    <img src="https://i.ibb.co/Mk0PvwhM/Ji-Woo-COSMO-TALK-WEB.png" />
    <br/>
    <sup><strong>A FAST API self-host cosmo Talk web</strong></sup>
</p>

# Quick Start
```
git clone https://github.com/twkenxtis/cosmo-talk-web-server.git
cd cosmo-talk-web-server
pip install -r requirements.txt
python web.py
```

- **OTP 驗證登入**：支援透過 Email 發送與驗證 OTP 碼完成登入，並自動管理與更新憑證
- **頻道與訊息同步**：抓取頻道清單與成員 NDJSON 同步事件，支援遊標增量更新與本地快取合併
- **聊天介面與純文字匯出**：提供網頁聊天室檢視介面，並可將純文字訊息依時間戳記匯出為 `.txt`
- **回覆數、貼圖與回覆傳送**：支援查詢頻道回覆數與貼圖列表，並可針對指定或最新訊息送出回覆內容
