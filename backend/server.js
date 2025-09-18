const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sql = require('mssql');
const Automerge = require('@automerge/automerge');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// 中間件
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.raw({ type: 'application/octet-stream', limit: '10mb' }));

// 資料庫配置
const dbConfig = {
  user: 'sa',
  password: 'Makalot1234',
  server: '192.168.255.6',
  port: 63422,
  database: 'POC',
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

// 全域變數存儲 CRDT 文檔（在生產環境中應該使用持久化存儲）
let currentDocument = Automerge.init();

// 輸入驗證函數
function validateEmployee(employee) {
  const errors = [];
  
  if (!employee.FirstName || employee.FirstName.trim().length === 0) {
    errors.push('FirstName is required');
  }
  if (!employee.LastName || employee.LastName.trim().length === 0) {
    errors.push('LastName is required');
  }
  if (employee.Email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.Email)) {
    errors.push('Invalid email format');
  }
  if (employee.PhoneNumber && !/^[\d\-\+\(\)\s]+$/.test(employee.PhoneNumber)) {
    errors.push('Invalid phone number format');
  }
  
  return errors;
}

// 清理輸入數據
function sanitizeEmployee(employee) {
  // 安全轉換為字符串的輔助函數
  const toSafeString = (value) => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  };

  return {
    EmployeeID: employee.EmployeeID,
    FirstName: toSafeString(employee.FirstName),
    LastName: toSafeString(employee.LastName),
    Department: toSafeString(employee.Department),
    Position: toSafeString(employee.Position),
    HireDate: employee.HireDate || null,
    BirthDate: employee.BirthDate || null,
    Gender: toSafeString(employee.Gender),
    Email: toSafeString(employee.Email),
    PhoneNumber: toSafeString(employee.PhoneNumber),
    Address: toSafeString(employee.Address),
    Status: toSafeString(employee.Status) || '在職'
  };
}

// 初始化文檔結構
currentDocument = Automerge.change(currentDocument, doc => {
  doc.employees = {};
  doc.lastModified = Date.now();
});

// 連接資料庫
async function connectDB() {
  try {
    await sql.connect(dbConfig);
    console.log('Connected to SQL Server database');
    
    // 載入現有資料到 CRDT 文檔
    await loadExistingData();
  } catch (err) {
    console.error('Database connection failed:', err);
  }
}

// 載入現有資料到 CRDT 文檔
async function loadExistingData() {
  try {
    const result = await sql.query(`
      SELECT EmployeeID, FirstName, LastName, Department, Position, 
             HireDate, BirthDate, Gender, Email, PhoneNumber, Address, Status
      FROM [POC].[dbo].[Employee]
    `);
    
    currentDocument = Automerge.change(currentDocument, doc => {
      result.recordset.forEach(emp => {
        doc.employees[emp.EmployeeID] = {
          EmployeeID: emp.EmployeeID,
          FirstName: emp.FirstName || '',
          LastName: emp.LastName || '',
          Department: emp.Department || '',
          Position: emp.Position || '',
          HireDate: emp.HireDate ? emp.HireDate.toISOString().split('T')[0] : '',
          BirthDate: emp.BirthDate ? emp.BirthDate.toISOString().split('T')[0] : '',
          Gender: emp.Gender || '',
          Email: emp.Email || '',
          PhoneNumber: emp.PhoneNumber || '',
          Address: emp.Address || '',
          Status: emp.Status || '在職'
        };
      });
      doc.lastModified = Date.now();
    });
    
    console.log(`Loaded ${result.recordset.length} employees into CRDT document`);
  } catch (err) {
    console.error('Failed to load existing data:', err);
  }
}

// 將 CRDT 文檔同步到資料庫
async function syncToDatabase() {
  const transaction = new sql.Transaction();
  
  try {
    await transaction.begin();
    
    const employees = currentDocument.employees;
    
    for (const [employeeId, employee] of Object.entries(employees)) {
      // 跳過新增的員工（這些是離線新增的，需要特殊處理）
      if (employeeId.startsWith('new-') || employeeId.startsWith('temp-')) {
        console.log('跳過新增員工:', employeeId, employee);
        continue;
      }
      
      // 軟刪除：若 Status 標記為 Deleted，執行實體刪除
      if (employee.Status === 'Deleted') {
        await transaction.request().query(`
          DELETE FROM Employee WHERE EmployeeID = ${employeeId}
        `);
        // 從 CRDT 文檔中移除
        currentDocument = Automerge.change(currentDocument, doc => {
          delete doc.employees[employeeId];
          doc.lastModified = Date.now();
        });
        continue;
      }

      // 檢查員工是否已存在
      const checkResult = await transaction.request().query(`
        SELECT COUNT(*) as count FROM Employee WHERE EmployeeID = ${employeeId}
      `);
      
      if (checkResult.recordset[0].count > 0) {
        // 更新現有員工
        await transaction.request().query(`
          UPDATE Employee SET
            FirstName = '${employee.FirstName}',
            LastName = '${employee.LastName}',
            Department = '${employee.Department}',
            Position = '${employee.Position}',
            HireDate = ${employee.HireDate ? `'${employee.HireDate}'` : 'NULL'},
            BirthDate = ${employee.BirthDate ? `'${employee.BirthDate}'` : 'NULL'},
            Gender = '${employee.Gender}',
            Email = '${employee.Email}',
            PhoneNumber = '${employee.PhoneNumber}',
            Address = '${employee.Address}',
            Status = '${employee.Status}'
          WHERE EmployeeID = ${employeeId}
        `);
      } else {
        // 插入新員工
        await transaction.request().query(`
          INSERT INTO Employee (
            FirstName, LastName, Department, Position,
            HireDate, BirthDate, Gender, Email, PhoneNumber, Address, Status
          ) VALUES (
            
            '${employee.FirstName}',
            '${employee.LastName}',
            '${employee.Department}',
            '${employee.Position}',
            ${employee.HireDate ? `'${employee.HireDate}'` : 'NULL'},
            ${employee.BirthDate ? `'${employee.BirthDate}'` : 'NULL'},
            '${employee.Gender}',
            '${employee.Email}',
            '${employee.PhoneNumber}',
            '${employee.Address}',
            '${employee.Status}'
          )
        `);
      }
    }
    
    // 警告：不可在此用 NOT IN 全量刪除，避免誤刪資料。
    // 若要支援刪除，應透過顯式 delete 事件或 soft-delete 欄位進行。
    
    await transaction.commit();
    console.log('Database synchronized successfully');
  } catch (err) {
    await transaction.rollback();
    console.error('Database sync failed:', err);
    throw err;
  }
}

// API 路由

// 健康檢查
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 獲取 CRDT 文檔
app.get('/api/sync/document', (req, res) => {
  try {
    const documentBytes = Automerge.save(currentDocument);
    res.set('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(documentBytes));
  } catch (err) {
    console.error('Failed to send document:', err);
    res.status(500).json({ error: 'Failed to retrieve document' });
  }
});

// 接收並合併 CRDT 文檔
app.post('/api/sync/document', async (req, res) => {
  try {
    const incomingBytes = new Uint8Array(req.body);
    const incomingDocument = Automerge.load(incomingBytes);
    
    // 合併文檔
    const oldDocument = currentDocument;
    currentDocument = Automerge.merge(currentDocument, incomingDocument);
    
    // 檢查是否有變更
    const hasChanges = !Automerge.equals(oldDocument, currentDocument);
    
    if (hasChanges) {
      // 先處理離線新增的員工
      await processOfflineEmployees();
      
      // 同步到資料庫
      await syncToDatabase();
      console.log('Document merged and synced to database');
    }
    
    res.json({ 
      success: true, 
      merged: hasChanges,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('Failed to merge document:', err);
    res.status(500).json({ error: 'Failed to merge document' });
  }
});

// 獲取所有員工（傳統 REST API）
app.get('/api/employees', async (req, res) => {
  try {
    console.log('API: 正在執行員工查詢...');
    const result = await sql.query(`
      SELECT EmployeeID, FirstName, LastName, Department, Position, 
             HireDate, BirthDate, Gender, Email, PhoneNumber, Address, Status
      FROM [POC].[dbo].[Employee]
      ORDER BY FirstName, LastName
    `);
    
    console.log(`API: 查詢完成，找到 ${result.recordset.length} 名員工`);
    console.log('API: 第一筆資料:', result.recordset[0] || 'No records');
    
    res.json(result.recordset);
  } catch (err) {
    console.error('Failed to fetch employees:', err);
    console.error('API 錯誤詳情:', err.message);
    res.status(500).json({ error: 'Failed to fetch employees', details: err.message });
  }
});

// 新增員工（傳統 REST API）
app.post('/api/employees', async (req, res) => {
  try {
    console.log('POST /api/employees - 收到請求:', req.body);
    
    const employee = req.body;
    
    // 基本驗證
    if (!employee.FirstName || !employee.LastName) {
      return res.status(400).json({ 
        error: 'FirstName and LastName are required' 
      });
    }
    
    console.log('準備插入員工資料:', employee);
    
    // 插入員工資料（不包含 EmployeeID，讓資料庫自動生成）
    const result = await sql.query(`
      INSERT INTO [POC].[dbo].[Employee] (
        FirstName, LastName, Department, Position,
        HireDate, BirthDate, Gender, Email, PhoneNumber, Address, Status
      )
      OUTPUT INSERTED.EmployeeID
      VALUES (
        '${(employee.FirstName || '').replace(/'/g, "''")}',
        '${(employee.LastName || '').replace(/'/g, "''")}',
        '${(employee.Department || '').replace(/'/g, "''")}',
        '${(employee.Position || '').replace(/'/g, "''")}',
        ${employee.HireDate ? `'${employee.HireDate}'` : 'NULL'},
        ${employee.BirthDate ? `'${employee.BirthDate}'` : 'NULL'},
        '${(employee.Gender || '').replace(/'/g, "''")}',
        '${(employee.Email || '').replace(/'/g, "''")}',
        '${(employee.PhoneNumber || '').replace(/'/g, "''")}',
        '${(employee.Address || '').replace(/'/g, "''")}',
        '${(employee.Status || 'Active').replace(/'/g, "''")}'
      )
    `);
    
    console.log('SQL 插入成功:', result);
    
    // 取得自動生成的 EmployeeID
    const employeeId = result.recordset[0].EmployeeID;
    console.log('新生成的 EmployeeID:', employeeId);
    
    const newEmployee = {
      EmployeeID: employeeId,
      FirstName: employee.FirstName || '',
      LastName: employee.LastName || '',
      Department: employee.Department || '',
      Position: employee.Position || '',
      HireDate: employee.HireDate || null,
      BirthDate: employee.BirthDate || null,
      Gender: employee.Gender || '',
      Email: employee.Email || '',
      PhoneNumber: employee.PhoneNumber || '',
      Address: employee.Address || '',
      Status: employee.Status || 'Active'
    };
    
    // 更新 CRDT 文檔
    currentDocument = Automerge.change(currentDocument, doc => {
      doc.employees[employeeId] = newEmployee;
      doc.lastModified = Date.now();
    });
    
    console.log('CRDT 文檔已更新');
    
    res.json({ success: true, employee: newEmployee });
  } catch (err) {
    console.error('Failed to create employee:', err);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

// 更新員工（傳統 REST API）
app.put('/api/employees/:id', async (req, res) => {
  try {
    const employeeId = req.params.id;
    const employee = req.body;
    
    console.log('PUT /api/employees/:id - 收到請求:', { employeeId, employee });
    
    // 基本驗證
    if (!employee.FirstName || !employee.LastName) {
      return res.status(400).json({ 
        error: 'FirstName and LastName are required' 
      });
    }
    
    // 使用簡單的字符串更新
    const result = await sql.query(`
      UPDATE [POC].[dbo].[Employee] SET
        FirstName = '${(employee.FirstName || '').replace(/'/g, "''")}',
        LastName = '${(employee.LastName || '').replace(/'/g, "''")}',
        Department = '${(employee.Department || '').replace(/'/g, "''")}',
        Position = '${(employee.Position || '').replace(/'/g, "''")}',
        HireDate = ${employee.HireDate ? `'${employee.HireDate}'` : 'NULL'},
        BirthDate = ${employee.BirthDate ? `'${employee.BirthDate}'` : 'NULL'},
        Gender = '${(employee.Gender || '').replace(/'/g, "''")}',
        Email = '${(employee.Email || '').replace(/'/g, "''")}',
        PhoneNumber = '${(employee.PhoneNumber || '').replace(/'/g, "''")}',
        Address = '${(employee.Address || '').replace(/'/g, "''")}',
        Status = '${(employee.Status || 'Active').replace(/'/g, "''")}'
      WHERE EmployeeID = ${employeeId}
    `);
    
    console.log('SQL 更新成功:', result);
    
    const updatedEmployee = {
      EmployeeID: employeeId,
      FirstName: employee.FirstName || '',
      LastName: employee.LastName || '',
      Department: employee.Department || '',
      Position: employee.Position || '',
      HireDate: employee.HireDate || null,
      BirthDate: employee.BirthDate || null,
      Gender: employee.Gender || '',
      Email: employee.Email || '',
      PhoneNumber: employee.PhoneNumber || '',
      Address: employee.Address || '',
      Status: employee.Status || '在職'
    };
    
    // 更新 CRDT 文檔
    currentDocument = Automerge.change(currentDocument, doc => {
      doc.employees[employeeId] = updatedEmployee;
      doc.lastModified = Date.now();
    });
    
    console.log('CRDT 文檔已更新');
    
    res.json({ success: true, employee: updatedEmployee });
  } catch (err) {
    console.error('Failed to update employee:', err);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// 刪除員工（傳統 REST API）
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const employeeId = req.params.id;
    
    console.log('DELETE /api/employees/:id - 收到請求:', { employeeId });
    
    // 使用簡單的字符串刪除
    const result = await sql.query(`DELETE FROM [POC].[dbo].[Employee] WHERE EmployeeID = ${employeeId}`);
    
    console.log('SQL 刪除成功:', result);
    
    // 更新 CRDT 文檔
    currentDocument = Automerge.change(currentDocument, doc => {
      delete doc.employees[employeeId];
      doc.lastModified = Date.now();
    });
    
    console.log('CRDT 文檔已更新，員工已刪除');
    
    res.json({ success: true, deletedId: employeeId });
  } catch (err) {
    console.error('Failed to delete employee:', err);
    res.status(500).json({ error: 'Failed to delete employee' });
  }
});

// 處理離線新增的員工
async function processOfflineEmployees() {
  const employees = currentDocument.employees;
  const newEmployees = [];
  
  // 找出所有新增的員工：
  // 1) 以 new- 開頭的鍵（離線建立）
  // 2) EmployeeID <= 0（本地暫時負數或 0）
  for (const [employeeKey, employee] of Object.entries(employees)) {
    const isNewKey = typeof employeeKey === 'string' && employeeKey.startsWith('new-');
    const isTempId = typeof employee?.EmployeeID === 'number' && employee.EmployeeID <= 0;
    if (isNewKey || isTempId) {
      newEmployees.push({ key: employeeKey, employee });
    }
  }
  
  console.log('發現離線新增的員工:', newEmployees.length, '個');
  
  // 為每個新員工生成真實 ID 並插入資料庫
  for (const { key, employee } of newEmployees) {
    try {
      // 統一轉字串與防止 .replace 對非字串拋錯
      const toSafeString = (v) => String(v ?? '').replace(/'/g, "''");
      const toSqlDateOrNull = (v) => {
        const s = typeof v === 'string' ? v : '';
        return s ? `'${s}'` : 'NULL';
      };

      const sanitized = sanitizeEmployee(employee);

      // 插入員工資料（不包含 EmployeeID，讓資料庫自動生成）
      const result = await sql.query(`
        INSERT INTO [POC].[dbo].[Employee] (
          FirstName, LastName, Department, Position,
          HireDate, BirthDate, Gender, Email, PhoneNumber, Address, Status
        )
        OUTPUT INSERTED.EmployeeID
        VALUES (
          '${toSafeString(sanitized.FirstName)}',
          '${toSafeString(sanitized.LastName)}',
          '${toSafeString(sanitized.Department)}',
          '${toSafeString(sanitized.Position)}',
          ${toSqlDateOrNull(sanitized.HireDate)},
          ${toSqlDateOrNull(sanitized.BirthDate)},
          '${toSafeString(sanitized.Gender)}',
          '${toSafeString(sanitized.Email)}',
          '${toSafeString(sanitized.PhoneNumber)}',
          '${toSafeString(sanitized.Address)}',
          '${toSafeString(sanitized.Status || 'Active')}'
        )
      `);
      
      const newEmployeeId = result.recordset[0].EmployeeID;
      console.log('離線員工已插入，新 ID:', newEmployeeId, '原鍵:', key);
      
      // 更新 CRDT 文檔，將臨時鍵替換為真實 ID
      currentDocument = Automerge.change(currentDocument, doc => {
        const updatedEmployee = { ...employee, EmployeeID: newEmployeeId };
        delete doc.employees[key];
        doc.employees[String(newEmployeeId)] = updatedEmployee;
        doc.lastModified = Date.now();
      });
      
    } catch (err) {
      console.error('處理離線員工失敗:', key, err);
    }
  }
}

// 錯誤處理中間件
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// 啟動服務器
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await connectDB();
});
// 優雅關閉
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await sql.close();
  process.exit(0);
}); 
