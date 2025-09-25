# 🚀 部署指南 - 離線 PWA 員工管理系統

## 📋 部署前準備

### 1. 確認檔案已創建
- ✅ `render.yaml` - Render 後端部署配置
- ✅ `vercel.json` - Vercel 前端部署配置  
- ✅ `env.example` - 環境變數範例
- ✅ `backend/server.js` - 已更新 CORS 設定
- ✅ `package.json` - 已新增 vercel-build 腳本
- ✅ `quasar.config.ts` - 已更新建置設定

### 2. 準備環境變數
複製 `env.example` 為 `.env` 並填入實際值：
```bash
cp env.example .env
```

## 🔧 部署步驟

### 第一步：部署後端到 Render

#### 1. 註冊 Render 帳號
- 前往 [render.com](https://render.com)
- 使用 GitHub 帳號註冊

#### 2. 創建 Web Service
1. 點擊 "New +" → "Web Service"
2. 連接 GitHub 倉庫
3. 設定：
   - **Name**: `employee-api`
   - **Root Directory**: `backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free`

#### 3. 設定環境變數
在 Render 的 Environment Variables 中設定：
```
NODE_ENV=production
PORT=3001
DB_USER=你的資料庫使用者名稱
DB_PASSWORD=你的資料庫密碼
DB_SERVER=你的SQL Server IP位址
DB_PORT=1433
DB_DATABASE=你的資料庫名稱
```

#### 4. 部署
- 點擊 "Create Web Service"
- 等待建置完成（約 2-3 分鐘）
- 記錄後端 URL：`https://employee-api-xxxx.onrender.com`

### 第二步：部署前端到 Vercel

#### 1. 更新 API 位址
修改 `vercel.json` 中的 API 位址：
```json
{
  "env": {
    "VITE_API_BASE": "https://employee-api-xxxx.onrender.com/api"
  }
}
```

#### 2. 註冊 Vercel 帳號
- 前往 [vercel.com](https://vercel.com)
- 使用 GitHub 帳號註冊

#### 3. 部署前端
1. 在 Vercel 中點擊 "New Project"
2. 選擇 GitHub 倉庫
3. 設定：
   - **Framework Preset**: `Other`
   - **Root Directory**: `./` (根目錄)
   - **Build Command**: `npm run vercel-build`
   - **Output Directory**: `dist/pwa`
   - **Install Command**: `npm install`

#### 4. 設定環境變數
在 Vercel 的 Environment Variables 中設定：
```
VITE_API_BASE=https://employee-api-xxxx.onrender.com/api
```

#### 5. 部署
- 點擊 "Deploy"
- 等待建置完成（約 3-5 分鐘）
- 記錄前端 URL：`https://pwa-employee-management.vercel.app`

### 第三步：更新 CORS 設定

#### 1. 更新後端 CORS
修改 `backend/server.js` 中的 CORS 設定：
```javascript
app.use(cors({
  origin: [
    'https://pwa-employee-management.vercel.app', // 實際的 Vercel 域名
    'http://localhost:9000',
    'http://localhost:9200'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
```

#### 2. 重新部署後端
- 在 Render 中點擊 "Manual Deploy"
- 選擇 "Deploy latest commit"

## 🧪 測試部署

### 1. 測試後端 API
```bash
# 測試健康檢查
curl https://employee-api-xxxx.onrender.com/api/health

# 測試員工列表
curl https://employee-api-xxxx.onrender.com/api/employees
```

### 2. 測試前端
1. 訪問 Vercel 部署的 URL
2. 檢查 PWA 功能：
   - 是否顯示 "Add to Home Screen" 提示
   - 離線功能是否正常
   - 同步功能是否正常

### 3. 測試完整流程
1. 新增員工
2. 離線操作
3. 恢復網路
4. 檢查同步

## 🔧 故障排除

### 常見問題

#### 後端部署失敗
- 檢查環境變數設定
- 確認 SQL Server 連線
- 查看 Render 日誌

#### 前端建置失敗
- 檢查 Node.js 版本
- 確認依賴安裝
- 查看 Vercel 建置日誌

#### CORS 錯誤
- 確認後端 CORS 設定
- 檢查前端 API 位址
- 重新部署後端

#### PWA 功能異常
- 確認 HTTPS 設定
- 檢查 Service Worker 註冊
- 驗證 Manifest 檔案

## 📊 部署檢查清單

### 後端檢查
- [ ] Render 部署成功
- [ ] 環境變數設定正確
- [ ] SQL Server 連線正常
- [ ] API 端點可正常訪問
- [ ] CORS 設定允許前端域名

### 前端檢查
- [ ] Vercel 部署成功
- [ ] PWA 建置無錯誤
- [ ] Service Worker 註冊成功
- [ ] API 連線正常
- [ ] 離線功能正常

### 整體功能檢查
- [ ] 員工 CRUD 操作正常
- [ ] 離線同步功能正常
- [ ] 多設備協作正常
- [ ] 資料庫資料一致性

## 💰 成本估算

### Render (後端)
- **免費方案**: 每月 750 小時
- **休眠時間**: 15 分鐘無活動後休眠
- **喚醒時間**: 首次請求約 30 秒

### Vercel (前端)
- **免費方案**: 每月 100GB 頻寬
- **建置時間**: 每月 6000 分鐘
- **函數執行**: 每月 100GB-小時

## 🎯 完成！

部署完成後，您的離線 PWA 員工管理系統將在雲端正常運行，支援：
- ✅ 離線資料操作
- ✅ 自動同步
- ✅ 多設備協作
- ✅ PWA 安裝功能
- ✅ 響應式設計
