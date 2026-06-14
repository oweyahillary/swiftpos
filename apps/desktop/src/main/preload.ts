import { contextBridge, ipcRenderer } from 'electron';

// All renderer → main communication goes through this bridge.
// The renderer never has direct access to Node.js or Electron internals.
contextBridge.exposeInMainWorld('swiftpos', {
  version: process.env.npm_package_version ?? '0.0.1',
  platform: process.platform,

  auth: {
    login:      (email: string, password: string) => ipcRenderer.invoke('auth:login', { email, password }),
    logout:     ()                                 => ipcRenderer.invoke('auth:logout'),
    getSession: ()                                 => ipcRenderer.invoke('auth:getSession'),
    listBranches:      ()                                 => ipcRenderer.invoke('auth:listBranches'),
    verifyPin:         (pin: string, branch_id: string)   => ipcRenderer.invoke('auth:verifyPin', { pin, branch_id }),
    getStaffSession:   ()                                 => ipcRenderer.invoke('auth:getStaffSession'),
    clearStaffSession: ()                                 => ipcRenderer.invoke('auth:clearStaffSession'),
  },

  pos: {
    init:         ()                  => ipcRenderer.invoke('pos:init'),
    getVariants:  (productId: string) => ipcRenderer.invoke('pos:getVariants', productId),
    getModifiers: (productId: string) => ipcRenderer.invoke('pos:getModifiers', productId),
    getTables:    ()                  => ipcRenderer.invoke('pos:getTables'),
    getPumps:     ()                  => ipcRenderer.invoke('pos:getPumps'),
  },

  order: {
    create: (payload: any) => ipcRenderer.invoke('order:create', payload),
    void:   (orderId: string, reason: string, supervisor_pin?: string) =>
              ipcRenderer.invoke('order:void', { orderId, reason, supervisor_pin }),
  },

  sync: {
    trigger:      () => ipcRenderer.invoke('sync:trigger'),
    status:       () => ipcRenderer.invoke('sync:status'),
    retryFailed:  () => ipcRenderer.invoke('sync:retryFailed'),
    notifyNetworkChange: (online: boolean) => ipcRenderer.invoke('net:changed', online),
  },

  print: {
    list: () => ipcRenderer.invoke('print:list'),
    html: (opts: { html: string; deviceName: string; paperWidthMm: 58 | 80; copies: number }) =>
      ipcRenderer.invoke('print:html', opts),
  },

  config: {
    get:            ()             => ipcRenderer.invoke('config:get'),
    isConfigured:   ()             => ipcRenderer.invoke('config:isConfigured'),
    save:           (patch: any)   => ipcRenderer.invoke('config:save', patch),
    clear:          ()             => ipcRenderer.invoke('config:clear'),
    testConnection: (url: string)  => ipcRenderer.invoke('config:testConnection', url),
  },

  shift: {
    current: ()                                                          => ipcRenderer.invoke('shift:current'),
    open:    (opening_float: number)                                     => ipcRenderer.invoke('shift:open', { opening_float }),
    float:   (type: 'float_in' | 'float_out', amount: number, reason?: string) => ipcRenderer.invoke('shift:float', { type, amount, reason }),
    close:   (closing_float: number, notes?: string)                     => ipcRenderer.invoke('shift:close', { closing_float, notes }),
    zreport: (shiftId: string)                                           => ipcRenderer.invoke('shift:zreport', shiftId),
  },

  manager: {
    salesSummary:   () => ipcRenderer.invoke('manager:salesSummary'),
    topProducts:    () => ipcRenderer.invoke('manager:topProducts'),
    recentOrders:   () => ipcRenderer.invoke('manager:recentOrders'),
    stockLevels:    () => ipcRenderer.invoke('manager:stockLevels'),
    fuelSales:      () => ipcRenderer.invoke('manager:fuelSales'),
    pumpStatus:     () => ipcRenderer.invoke('manager:pumpStatus'),
    tableOccupancy: () => ipcRenderer.invoke('manager:tableOccupancy'),
  },

  expense: {
    categories: () => ipcRenderer.invoke('expense:categories'),
    create: (payload: { description: string; amount: number; expense_category_id?: string; paid_by?: string }) =>
              ipcRenderer.invoke('expense:create', payload),
    list: () => ipcRenderer.invoke('expense:list'),
  },
});
