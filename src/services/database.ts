import Dexie, { type Table } from 'dexie';
import type { Employee, EmployeeChange, SyncState } from '../types/employee';

export class EmployeeDatabase extends Dexie {
  employees!: Table<Employee>;
  changes!: Table<EmployeeChange>;
  syncState!: Table<SyncState>;

  constructor() {
    super('EmployeeDatabase');
    this.version(1).stores({
      employees: 'EmployeeID, FirstName, LastName, Department, Position, Email',
      changes: '++id, EmployeeID, timestamp, operation, synced',
      syncState: '++id, lastSyncTimestamp'
    });
    
    // 版本 2: 清理舊的 changes 數據，確保 synced 欄位使用 boolean
    this.version(2).stores({
      employees: 'EmployeeID, FirstName, LastName, Department, Position, Email',
      changes: '++id, EmployeeID, timestamp, operation, synced',
      syncState: '++id, lastSyncTimestamp'
    }).upgrade(async tx => {
      // 清除所有舊的 changes 記錄，重新開始
      await tx.table('changes').clear();
    });
  }

  // 新增員工
  async addEmployee(employee: Employee): Promise<void> {
    await this.transaction('rw', this.employees, this.changes, async () => {
      await this.employees.put(employee);
      await this.changes.add({
        employee,
        timestamp: Date.now(),
        operation: 'create',
        synced: false
      });
    });
  }

  // 更新員工
  async updateEmployee(employee: Employee): Promise<void> {
    await this.transaction('rw', this.employees, this.changes, async () => {
      await this.employees.put(employee);
      await this.changes.add({
        employee,
        timestamp: Date.now(),
        operation: 'update',
        synced: false
      });
    });
  }

  // 刪除員工
   async deleteEmployee(employeeId: number): Promise<void> {
    const employee = await this.employees.get(employeeId);
    if (employee) {
      await this.transaction('rw', this.employees, this.changes, async () => {
        await this.employees.delete(employeeId);
        await this.changes.add({
          employee,
          timestamp: Date.now(),
          operation: 'delete',
          synced: false
        });
      });
    }
  }

  // 獲取所有員工
  async getAllEmployees(): Promise<Employee[]> {
    return await this.employees.toArray();
  }

  // 獲取未同步的變更
  async getUnsyncedChanges(): Promise<EmployeeChange[]> {
    return await this.changes.filter(change => change.synced === false).toArray();
  }

  // 標記變更為已同步
  async markChangesSynced(changeIds: number[]): Promise<void> {
    await this.changes.where('id').anyOf(changeIds).modify({ synced: true });
  }

  // 清除所有未同步的變更記錄（用於重置）
  async clearAllUnsyncedChanges(): Promise<void> {
    await this.changes.filter(change => change.synced === false).delete();
  }

  // 根據員工資料清除變更記錄（用於離線新增後）
  async clearChangesByEmployeeData(employeeData: Partial<Employee>): Promise<void> {
    const changes = await this.changes.filter(change => change.synced === false).toArray();
    
    const matchingChanges = changes.filter(change => {
      const emp = change.employee;
      return (
        emp.FirstName === employeeData.FirstName &&
        emp.LastName === employeeData.LastName &&
        emp.Email === employeeData.Email &&
        change.operation === 'create'
      );
    });
    
    if (matchingChanges.length > 0) {
      const changeIds = matchingChanges.map(c => c.id).filter(id => id !== undefined) as number[];
      await this.markChangesSynced(changeIds);
      console.log(`根據員工資料清除了 ${changeIds.length} 個變更記錄`);
    }
  }

  // 清除已同步的變更（保留最近的記錄）
  async cleanupSyncedChanges(): Promise<void> {
    const cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000); // 保留7天
    await this.changes.filter(change => 
      change.synced === true && change.timestamp < cutoffTime
    ).delete();
  }

  // 獲取同步狀態
  async getSyncState(): Promise<SyncState | undefined> {
    return await this.syncState.orderBy('id').last();
  }

  // 更新同步狀態
  async updateSyncState(state: Partial<SyncState>): Promise<void> {
    const currentState = await this.getSyncState();
    if (currentState) {
      await this.syncState.update(currentState.id!, state);
    } else {
      await this.syncState.add({
        lastSyncTimestamp: 0,
        pendingChanges: [],
        isOnline: navigator.onLine,
        isSyncing: false,
        ...state
      } as SyncState);
    }
  }

  // 直接從 API 獲取員工數據（測試用）
  async fetchEmployeesFromAPI(): Promise<Employee[]> {
    const response = await fetch('http://localhost:3001/api/employees');
    if (!response.ok) {
      throw new Error(`API 請求失敗: ${response.status} ${response.statusText}`);
    }
    const employees: Employee[] = await response.json();
    
    // 將數據也存儲到本地數據庫
    await this.employees.clear();
    await this.employees.bulkPut(employees);
    
    return employees;
  }
}

export const db = new EmployeeDatabase(); 