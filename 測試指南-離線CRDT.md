# 🧪 離線功能與 CRDT 測試指南

## 📋 測試清單

### ✅ 測試 1: 基本離線功能
### ✅ 測試 2: 離線 CRUD 操作
### ✅ 測試 3: CRDT 多用戶衝突解決
### ✅ 測試 4: 網路恢復後自動同步
### ✅ 測試 5: IndexedDB 資料持久化

---

## 🔧 測試環境準備

1. **啟動服務**：
   ```bash
   # 前端 PWA
   npm run dev:pwa
   
   # 後端 API  
   cd backend && node server.js
   ```

2. **瀏覽器準備**：
   - 開啟 Chrome/Edge
   - 打開開發者工具 (F12)
   - 準備多個標籤頁

---
## 🧪 測試 1: 基本離線功能

### 步驟：
1. **在線狀態確認**
   - 訪問 `http://localhost:9200`
   - 確認員工列表載入正常
   - 檢查右上角狀態顯示「已同步」

2. **模擬離線**
   - F12 → Network 標籤
   - 勾選 ☑️ "Offline"
   - 重新整理頁面

3. **預期結果**
   - ✅ 頁面仍能正常載入
   - ✅ 員工列表依然顯示（來自 IndexedDB）
   - ✅ 狀態顯示「離線模式」
   - ✅ 同步按鈕變灰色（不可點擊）

### 失敗排除：
- 如果白屏：檢查 Service Worker 是否註冊成功
- 如果無資料：先在線上載入一次資料

---

## 🧪 測試 2: 離線 CRUD 操作

### 新增員工（離線）
1. **保持離線狀態**
2. **點擊「新增員工」**
3. **填寫員工資料**：
   ```
   姓名: 測試離線
   部門: IT
   職位: 開發者
   ```
4. **點擊保存**

### 預期結果：
- ✅ 顯示「員工資料新增成功」
- ✅ 列表中出現新員工
- ✅ 狀態顯示「有 1 項變更待同步」

### 編輯員工（離線）
1. **選擇現有員工進行編輯**
2. **修改部門為「測試部門」**
3. **保存**

### 預期結果：
- ✅ 修改成功
- ✅ 狀態顯示「有 2 項變更待同步」

### 刪除員工（離線）
1. **選擇一個員工刪除**
2. **確認刪除**

### 預期結果：
- ✅ 員工從列表消失
- ✅ 狀態顯示「有 3 項變更待同步」

---

## 🧪 測試 3: CRDT 多用戶衝突解決

### 準備兩個瀏覽器標籤
1. **標籤 A**: `http://localhost:9200`
2. **標籤 B**: `http://localhost:9200`（新標籤）

### 並發編輯測試
1. **確保兩個標籤都在線**
2. **同時選擇同一個員工編輯**：
   
   **標籤 A**:
   - 修改部門：「IT」→「開發部」
   - 保存

   **標籤 B**:
   - 修改職位：「Developer」→「高級開發工程師」  
   - 保存

3. **等待同步完成**
4. **重新整理兩個標籤**

### 預期結果：
- ✅ 兩個標籤顯示相同資料
- ✅ 部門 = 「開發部」（來自標籤 A）
- ✅ 職位 = 「高級開發工程師」（來自標籤 B）
- ✅ **沒有資料遺失**（這就是 CRDT 的魔法！）

---

## 🧪 測試 4: 網路恢復後自動同步

### 從離線恢復
1. **保持測試 2 的離線狀態**
2. **取消 Network 標籤的 "Offline" 勾選**
3. **點擊同步按鈕**

### 預期結果：
- ✅ 同步開始（圈圈轉動）
- ✅ Console 顯示同步日誌：
   ```
   🔄 開始同步...
   📝 應用本地變更...
   📥 從伺服器獲取文檔...
   🔀 合併文檔...
   📤 推送文檔到伺服器...
   💾 更新本地資料庫...
   ✅ 標記變更為已同步...
   🎉 同步完成！
   ```
- ✅ 狀態恢復「已同步」

### 驗證資料持久化
1. **重新整理頁面**
2. **檢查離線時的變更是否保存到資料庫**

---

## 🧪 測試 5: IndexedDB 資料持久化

### 檢查 IndexedDB
1. **F12 → Application 標籤**
2. **左側選擇 IndexedDB → EmployeeDatabase**
3. **檢查表格**：
   - `employees`: 員工資料
   - `changes`: 未同步變更
   - `syncState`: 同步狀態

### Console 檢查
```javascript
// 在 Console 執行
// 檢查未同步變更
const changes = await (await indexedDB.open('EmployeeDatabase')).transaction('changes').objectStore('changes').getAll();
console.log('未同步變更:', changes);

// 檢查員工數量
const employees = await (await indexedDB.open('EmployeeDatabase')).transaction('employees').objectStore('employees').getAll();
console.log('本地員工數量:', employees.length);
```

---

## 🎯 高級測試：混合場景

### 複雜離線場景
1. **用戶 A 離線新增員工**
2. **用戶 B 在線修改同一資料集**
3. **用戶 A 恢復網路並同步**
4. **檢查 CRDT 是否正確合併所有變更**

### 網路不穩定測試
1. **間歇性網路中斷**
2. **檢查同步重試機制**
3. **驗證資料一致性**

---

## 🐛 常見問題排除

### Service Worker 問題
```javascript
// Console 檢查 SW 狀態
navigator.serviceWorker.getRegistrations().then(console.log);
```

### CRDT 同步問題
```javascript
// 檢查同步服務狀態
console.log(await syncService.getSyncStatus());
```

### IndexedDB 問題
```javascript
// 清空本地資料（測試用）
await db.clear();
```

---

## ✅ 測試檢核表

- [ ] 離線時頁面正常載入
- [ ] 離線 CRUD 操作成功
- [ ] 多用戶並發編輯無衝突
- [ ] 網路恢復後自動同步
- [ ] IndexedDB 資料持久化
- [ ] Service Worker 正常註冊
- [ ] CRDT 文檔正確合併
- [ ] 同步狀態正確顯示

完成所有測試後，你的離線 PWA 員工管理系統就經過了完整驗證！🎉
