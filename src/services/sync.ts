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
  private apiBaseUrl = 'http://localhost:3001/api'; // 後端 API URL

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
  private setupNetworkListeners() {
    window.addEventListener('online', () => {
      console.log('Network online - starting sync');
      void this.syncWithServer();
    });

    window.addEventListener('offline', () => {
      console.log('Network offline');
      void db.updateSyncState({ isOnline: false });
    });

    // 初始設置網路狀態
    void db.updateSyncState({ isOnline: navigator.onLine });
  }

  // 將本地變更應用到 CRDT 文檔
  async applyLocalChanges() {
    const unsyncedChanges = await db.getUnsyncedChanges();
    console.log('應用本地變更:', unsyncedChanges.length, '個變更');
    console.log('未同步變更詳情:', unsyncedChanges);
    
    // 記錄要清除的變更 ID
    const processedChangeIds: number[] = [];
    
    for (const employeeChange of unsyncedChanges) {
      console.log('處理變更:', employeeChange.operation, employeeChange.employee);
      
      this.document = change(this.document, (doc: EmployeeDocument) => {
        switch (employeeChange.operation) {
          case 'create': {
            // 新增員工時，不包含 EmployeeID，讓後端自動生成
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { EmployeeID: _, ...employeeData } = employeeChange.employee;
            const newEmployee = { ...employeeData, EmployeeID: 0 };
            
            // 使用員工資料作為唯一標識
            const createKey = `new-${employeeChange.employee.FirstName}-${employeeChange.employee.LastName}-${employeeChange.timestamp}`;
            doc.employees[createKey] = newEmployee;
            break;
          }
          case 'update': {
            // 更新員工時，使用 EmployeeID 作為鍵
            doc.employees[employeeChange.employee.EmployeeID] = employeeChange.employee;
            break;
          }
          case 'delete': {
            // 刪除員工時，使用 EmployeeID 作為鍵
            delete doc.employees[employeeChange.employee.EmployeeID];
            break;
          }
        }
        doc.lastModified = employeeChange.timestamp;
      });
      
      // 記錄已處理的變更 ID
      if (employeeChange.id !== undefined) {
        processedChangeIds.push(employeeChange.id);
      }
    }
    
    // 立即標記已處理的變更為已同步，避免重複處理
    if (processedChangeIds.length > 0) {
      await db.markChangesSynced(processedChangeIds);
      console.log('已標記變更為已同步:', processedChangeIds.length, '個');
    }
  }

  // 與伺服器同步
  async syncWithServer(): Promise<boolean> {
    if (!navigator.onLine) {
      console.log('Offline - skipping sync');
      return false;
    }

    try {
      await db.updateSyncState({ isSyncing: true });
      
      // 1. 獲取未同步的變更（在應用之前）
      const unsyncedChanges = await db.getUnsyncedChanges();
      console.log('找到未同步變更:', unsyncedChanges.length, '個');
      
      if (unsyncedChanges.length === 0) {
        console.log('沒有未同步的變更，跳過同步');
        await db.updateSyncState({ 
          isSyncing: false, 
          lastSyncTimestamp: Date.now() 
        });
        return true;
      }
      
      // 2. 將本地變更應用到文檔
      await this.applyLocalChanges();

      // 3. 從伺服器獲取最新文檔
      const serverDocument = await this.fetchServerDocument();
      
      // 4. 合併文檔（CRDT 自動解決衝突）
      if (serverDocument) {
        this.document = merge(this.document, serverDocument);
      }

      // 5. 將合併後的結果推送到伺服器
      await this.pushDocumentToServer();

      // 6. 更新本地資料庫
      await this.updateLocalDatabase();

      // 7. 變更記錄已在 applyLocalChanges 中標記為已同步，無需重複處理

      await db.updateSyncState({ 
        isSyncing: false, 
        lastSyncTimestamp: Date.now() 
      });

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
    const currentEmployees = await db.getAllEmployees();
    const currentEmployeeIds = new Set(currentEmployees.map(e => e.EmployeeID));
    
    // 從 CRDT 文檔中獲取員工資料
    const documentEmployees = this.document.employees;
    
    // 更新或新增員工
    for (const [employeeId, employee] of Object.entries(documentEmployees)) {
      await db.employees.put(employee);
      currentEmployeeIds.delete(Number(employeeId));
    }
    
    // 刪除在文檔中不存在的員工
    for (const employeeId of currentEmployeeIds) {
      await db.employees.delete(employeeId);
    }
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

  // 定期同步（如果在線）
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