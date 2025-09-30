import { 
  init, 
  change, 
  merge, 
  save, 
  load, 
  type Doc 
} from '@automerge/automerge';
import { db } from './database';
import type { Employee } from '../types/employee';

export interface EmployeeDocument {
  employees: Record<string, Employee>;
  lastModified: number;
}

export class SyncService {
  private document: Doc<EmployeeDocument>;
  private apiBaseUrl = (() => {
    const raw = (import.meta.env?.VITE_API_BASE as string) || 'http://localhost:3001/api';
    if (raw.endsWith('/api')) return raw;
    return `${String(raw).replace(/\/+$/, '')}/api`;
  })(); // 後端 API URL

  constructor() {
    // 初始化 Automerge 文檔
    this.document = init<EmployeeDocument>();
    this.initializeDocument();
    this.setupNetworkListeners();
  }

  private initializeDocument() {
    this.document = change(this.document, (doc: EmployeeDocument) => {
      doc.employees = {};
      doc.lastModified = Date.now();
    });
  }

  // 設置網路狀態監聽器
  private isSyncInProgress: boolean = false; // 防止重複同步
  private onlineSyncTimer?: number;  // 去抖定時器
  
  private setupNetworkListeners() {
    window.addEventListener('online', () => {
      console.log('Network online - starting sync');
  
      // 防止重複同步
      if (this.isSyncInProgress) {
        console.log('同步已在進行中，跳過此次觸發');
        return; // 如果正在同步，就跳過這次同步
      }
  
      // 清除現有的定時器
      if (this.onlineSyncTimer) {
        clearTimeout(this.onlineSyncTimer);
      }
  
      // 去抖處理：延遲500ms後開始同步，避免頻繁觸發
      this.onlineSyncTimer = window.setTimeout(() => {
        this.syncWithServer();
      }, 500); // 去抖延遲時間，可以根據需要調整
  
    });
  
    window.addEventListener('offline', () => {
      console.log('Network offline');
      void db.updateSyncState({ isOnline: false });
    });
  
    void db.updateSyncState({ isOnline: navigator.onLine });
  }
  

  // 將本地變更應用到 CRDT 文檔
  async applyLocalChanges(): Promise<number[]> {
    const unsyncedChanges = await db.getUnsyncedChanges();
    console.log('應用本地變更:', unsyncedChanges.length, '個變更');
    if (unsyncedChanges.length === 0) return [];
  
    const processedChangeIds: number[] = [];
  
    for (const ch of unsyncedChanges) {
      console.log('處理變更:', ch.operation, ch.employee);
  
      this.document = change(this.document, (doc: EmployeeDocument) => {
        switch (ch.operation) {
          case 'create': {
            // 新增：CRDT 內用 new- key；EmployeeID 先設 0 代表待分配
            const { EmployeeID: _unusedEmployeeId, ...rest } = ch.employee;
            void _unusedEmployeeId;
            const newEmployee = { ...rest, EmployeeID: 0 };
            const createKey = `new-${ch.employee.FirstName}-${ch.employee.LastName}-${ch.timestamp}`;
            doc.employees[createKey] = newEmployee;
            console.log('已添加新員工到 CRDT:', createKey);
            break;
          }
          case 'update': {
            const idNum = Number(ch.employee.EmployeeID);
            if (!Number.isInteger(idNum) || idNum <= 0) {
              // ID 不合法時，改用 create 流（避免後端誤判 INSERT，造成重複）
              const { EmployeeID: _unused, ...rest } = ch.employee;
              void _unused;
              const newEmployee = { ...rest, EmployeeID: 0 };
              const createKey = `new-${rest.FirstName ?? ''}-${rest.LastName ?? ''}-${ch.timestamp}`;
              doc.employees[createKey] = newEmployee;
              console.log('update 轉 create（ID 非法）:', createKey);
            } else {
              const key = String(idNum);
              doc.employees[key] = ch.employee;
              console.log('已更新員工到 CRDT:', key);
            }
            break;
          }
          case 'delete': {
            const key = String(ch.employee.EmployeeID); // 一律字串 key
            const existed = doc.employees[key] as unknown as Partial<Employee> | undefined;
            // 無論 existed 與否，都產生刪除意圖，確保後端會做硬刪
            const deleted: Employee = {
              EmployeeID: Number(existed?.EmployeeID ?? ch.employee.EmployeeID),
              FirstName: String(existed?.FirstName ?? ch.employee.FirstName ?? ''),
              LastName: String(existed?.LastName ?? ch.employee.LastName ?? ''),
              Department: String(existed?.Department ?? ch.employee.Department ?? ''),
              Position: String(existed?.Position ?? ch.employee.Position ?? ''),
              HireDate: String(existed?.HireDate ?? ch.employee.HireDate ?? ''),
              BirthDate: String(existed?.BirthDate ?? ch.employee.BirthDate ?? ''),
              Gender: String(existed?.Gender ?? ch.employee.Gender ?? ''),
              Email: String(existed?.Email ?? ch.employee.Email ?? ''),
              PhoneNumber: String(existed?.PhoneNumber ?? ch.employee.PhoneNumber ?? ''),
              Address: String(existed?.Address ?? ch.employee.Address ?? ''),
              Status: 'Deleted',
            };
            doc.employees[key] = deleted;
            console.log('已寫入刪除意圖（Deleted）以同步到後端:', key);
            break;
          }
        }
        doc.lastModified = ch.timestamp;
      });
  
      if (ch.id !== undefined) processedChangeIds.push(ch.id);
    }
  
    // ⚠️ 重點：不要在這裡標記 synced，等 push 成功後再標
    return processedChangeIds;
  }
  
  

  // 與伺服器同步
  async syncWithServer(): Promise<boolean> {
    if (!navigator.onLine) {
      console.log('Offline - skipping sync');
      return false;
    }
  
    try {
      await db.updateSyncState({ isSyncing: true });
  
      // 1) 讀未同步變更
      const pending = await db.getUnsyncedChanges();
      console.log('找到未同步變更:', pending.length, '個');
      // 移除過早返回：即使沒有本地待同步變更，也要抓伺服器 CRDT 並更新本地
  
      // 1.5) 抵銷「對同一暫時 ID 的 create 與 delete」
      // 規則：EmployeeID < 0 視為暫時 ID，若有 delete(暫時ID) → 移除該暫時ID的 create/delete 兩筆變更
      const tempIdsToDrop = new Set<number>();
      for (const ch of pending) {
        if (ch.operation === 'delete' && typeof ch.employee?.EmployeeID === 'number' && ch.employee.EmployeeID < 0) {
          tempIdsToDrop.add(ch.employee.EmployeeID);
        }
      }
      if (tempIdsToDrop.size > 0) {
        const toRemoveIds: number[] = [];
        for (const ch of pending) {
          if (typeof ch.employee?.EmployeeID === 'number' && tempIdsToDrop.has(ch.employee.EmployeeID)) {
            if (ch.id != null) toRemoveIds.push(ch.id);
          }
        }
        if (toRemoveIds.length) {
          await db.changes.where('id').anyOf(toRemoveIds).delete();
          console.log('已抵銷暫時ID的 create/delete 變更筆數：', toRemoveIds.length);
        }
      }
  
      // 2) 套用本地變更到 CRDT（拿到這批處理的 changeIds）
      const processedChangeIds = pending.length > 0 ? await this.applyLocalChanges() : [];
  
      // 3) 拉 server 文檔並合併
      const serverDocument = await this.fetchServerDocument();
      if (serverDocument) {
        this.document = merge(this.document, serverDocument);
      }
  
      // 4) 若有本地變更才推送合併後的結果到 server（避免無意義上傳）
      if (processedChangeIds.length > 0) {
        await this.pushDocumentToServer();
      }
  
      // 5) 推送成功 → 標記這批變更為 synced
      if (processedChangeIds.length) {
        await db.markChangesSynced(processedChangeIds);
        console.log('已標記變更為已同步:', processedChangeIds.length, '個');
      }
  
      // 6) 依 CRDT 覆寫本地資料庫（略過 Deleted/暫時 key/暫時 ID）
      await this.updateLocalDatabase();
  
      // 7) 清理 CRDT 臨時 key
      this.cleanCRDTDocument();
  
      await db.updateSyncState({ isSyncing: false, lastSyncTimestamp: Date.now() });
      console.log('Sync completed successfully');
      return true;
    } catch (error) {
      console.error('Sync failed:', error);
      await db.updateSyncState({ isSyncing: false });
      return false;
    }
  }
  

  // 從伺服器獲取文檔
  private async fetchServerDocument(): Promise<Doc<EmployeeDocument> | null> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/sync/document`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.arrayBuffer();
      return load(new Uint8Array(data));
    } catch (error) {
      console.warn('Failed to fetch server document:', error);
      return null;
    }
  }

  // 將文檔推送到伺服器
  private async pushDocumentToServer(): Promise<void> {
    const documentBytes = save(this.document);
    
    // 安全地處理 ArrayBufferLike 類型，確保轉換為 ArrayBuffer
    let arrayBuffer: ArrayBuffer;
    
    // 檢查是否為 SharedArrayBuffer（如果環境支持）
    if (typeof SharedArrayBuffer !== 'undefined' && documentBytes.buffer instanceof SharedArrayBuffer) {
      // 將 SharedArrayBuffer 轉換為 ArrayBuffer
      arrayBuffer = new ArrayBuffer(documentBytes.buffer.byteLength);
      new Uint8Array(arrayBuffer).set(new Uint8Array(documentBytes.buffer));
    } else {
      // 直接使用 ArrayBuffer 或創建新的 ArrayBuffer
      try {
        arrayBuffer = documentBytes.buffer as ArrayBuffer;
      } catch {
        // 如果轉換失敗，創建新的 ArrayBuffer
        arrayBuffer = new ArrayBuffer(documentBytes.byteLength);
        new Uint8Array(arrayBuffer).set(documentBytes);
      }
    }
    
    const body = new Blob([arrayBuffer], { type: 'application/octet-stream' });

    const response = await fetch(`${this.apiBaseUrl}/sync/document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to push document: HTTP ${response.status}`);
    }
  }

  // 更新本地資料庫
  private async updateLocalDatabase(): Promise<void> {
    console.log('開始更新本地資料庫...');
    
    // 從 CRDT 文檔中獲取員工資料，過濾掉臨時 ID 和臨時 key
    const documentEmployees = this.document.employees;
    const validEmployees: Employee[] = [];
    
    for (const [key, employee] of Object.entries(documentEmployees)) {
      // 跳過臨時 key
      if (key.startsWith('new-') || key.startsWith('temp-')) {
        continue;
      }
      // 跳過暫時 ID
      if (employee.EmployeeID <= 0) {
        continue;
      }
      // 跳過已標記刪除
      if ((employee as Partial<Employee>).Status === 'Deleted') {
        console.log('跳過已刪除員工:', employee.EmployeeID);
        continue;
      }
      validEmployees.push(employee);
    }
      
    
    console.log('有效的員工記錄數量:', validEmployees.length);
    
    // 清空現有的員工表
    await db.employees.clear();
    
    // 插入有效的員工記錄
    for (const employee of validEmployees) {
      await db.employees.put(employee);
    }
    
    console.log('本地資料庫更新完成');
  }

  // 清理 CRDT 文檔中的臨時記錄（就地刪除，避免引用外部物件）
  private cleanCRDTDocument(): void {
    const currentKeys = Object.keys(this.document.employees);
    const keysToDelete: string[] = [];

    for (const key of currentKeys) {
      const emp = this.document.employees[key] as unknown as Employee;
      const isTempKey = key.startsWith('new-') || key.startsWith('temp-');
      const isTempId = typeof emp?.EmployeeID === 'number' && emp.EmployeeID <= 0;
      if (isTempKey || isTempId) {
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length === 0) return;

    console.log('清理 CRDT 文檔中的臨時記錄...', keysToDelete);
    this.document = change(this.document, (doc: EmployeeDocument) => {
      for (const k of keysToDelete) {
        delete doc.employees[k];
      }
      doc.lastModified = Date.now();
    });
    console.log('CRDT 文檔清理完成');
  }

  // 手動觸發同步
  async manualSync(): Promise<boolean> {
    console.log('Manual sync triggered');
    return await this.syncWithServer();
  }

  // 自動同步（網路恢復時）
  async autoSync(): Promise<boolean> {
    if (!navigator.onLine) {
      return false;
    }

    try {
      console.log('開始自動同步...');
      return await this.syncWithServer();
    } catch (error) {
      console.error('自動同步失敗:', error);
      return false;
    }
  }

  // 獲取同步狀態
  async getSyncStatus() {
    const syncState = await db.getSyncState();
    const unsyncedCount = (await db.getUnsyncedChanges()).length;
    
    return {
      isOnline: navigator.onLine,
      isSyncing: syncState?.isSyncing || false,
      lastSyncTimestamp: syncState?.lastSyncTimestamp || 0,
      unsyncedChangesCount: unsyncedCount,
    };
  }

  // 調試：檢查 CRDT 文檔狀態
  debugCRDTDocument(): void {
    const documentEmployees = this.document.employees;
    const totalEmployees = Object.keys(documentEmployees).length;
    const tempRecords = Object.keys(documentEmployees).filter(key => 
      key.startsWith('new-') || key.startsWith('temp-')
    ).length;
    const validRecords = totalEmployees - tempRecords;
    
    console.log('CRDT 文檔狀態:');
    console.log(`  總記錄數: ${totalEmployees}`);
    console.log(`  有效記錄: ${validRecords}`);
    console.log(`  臨時記錄: ${tempRecords}`);
    
    if (tempRecords > 0) {
      console.log('  臨時記錄詳情:', Object.keys(documentEmployees).filter(key => 
        key.startsWith('new-') || key.startsWith('temp-')
      ));
    }
  }

  // 定期同步（如果online）
  startPeriodicSync(intervalMs: number = 30000) {
    setInterval(() => {
      void (async () => {
        if (navigator.onLine) {
          const unsyncedChanges = await db.getUnsyncedChanges();
          if (unsyncedChanges.length > 0) {
            await this.syncWithServer();
          }
        }
      })();
    }, intervalMs);
  }
}

export const syncService = new SyncService(); 