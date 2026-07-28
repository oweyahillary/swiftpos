import { contextBridge, ipcRenderer } from 'electron';

// All renderer → main communication goes through this bridge.
// The renderer never has direct access to Node.js or Electron internals.
contextBridge.exposeInMainWorld('swiftpos', {
  // sendSync so this stays a plain string on the bridge. npm_package_version is
  // only defined when Electron runs via an npm script, so packaged builds always
  // reported '0.0.1' regardless of the real version — useless when you are
  // trying to tell which build a till in a shop is running.
  version: (() => {
    try { return (ipcRenderer.sendSync('app:version') as string) || 'unknown'; }
    catch { return 'unknown'; }   // never let a version lookup break the bridge
  })(),
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
    void:   (orderId: string, reason: string, supervisor_pin?: string, authorizer_id?: string) =>
              ipcRenderer.invoke('order:void', { orderId, reason, supervisor_pin, authorizer_id }),
    refund: (orderId: string, reason: string, override_pin?: string, authorizer_id?: string) =>
              ipcRenderer.invoke('order:refund', { orderId, reason, override_pin, authorizer_id }),
  },

  sync: {
    trigger:      () => ipcRenderer.invoke('sync:trigger'),
    status:       () => ipcRenderer.invoke('sync:status'),
    retryFailed:  () => ipcRenderer.invoke('sync:retryFailed'),
    notifyNetworkChange: (online: boolean) => ipcRenderer.invoke('net:changed', online),
  },

  orders: {
    // Next terminal-prefixed bill number. Increments a persistent counter, so
    // call it only when a number will actually be used.
    nextBillNumber: () => ipcRenderer.invoke('orders:nextBillNumber'),
  },

  print: {
    list: () => ipcRenderer.invoke('print:list'),
    preview: (opts: any) => ipcRenderer.invoke('print:preview', opts),
    probe: (deviceName: string) => ipcRenderer.invoke('print:probe', deviceName),
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

  tech: {
    checkReveal:  (code: string)  => ipcRenderer.invoke('tech:checkReveal', code),
    openSession:  (token: string) => ipcRenderer.invoke('tech:openSession', token),
    getSession:   ()              => ipcRenderer.invoke('tech:getSession'),
    closeSession: ()              => ipcRenderer.invoke('tech:closeSession'),
    logAction:    (action: string, detail?: any) => ipcRenderer.invoke('tech:logAction', { action, detail }),
    status:       ()              => ipcRenderer.invoke('tech:status'),
    adoptFromNode:()              => ipcRenderer.invoke('tech:adoptFromNode'),
  },

  shift: {
    current: ()                                                          => ipcRenderer.invoke('shift:current'),
    open:    (opening_float: number)                                     => ipcRenderer.invoke('shift:open', { opening_float }),
    stale: () => ipcRenderer.invoke('shift:stale'),
    forceClose: (reason: string) => ipcRenderer.invoke('shift:forceClose', { reason }),
    float:   (type: 'float_in' | 'float_out', amount: number, reason?: string) => ipcRenderer.invoke('shift:float', { type, amount, reason }),
    close:   (closing_float: number, notes?: string)                     => ipcRenderer.invoke('shift:close', { closing_float, notes }),
    zreport: (shiftId: string)                                           => ipcRenderer.invoke('shift:zreport', shiftId),
  },

  // Catalogue and staff management. Online-only by design — see ipcHandlers.
  manage: {
    listProducts:   ()                                   => ipcRenderer.invoke('manage:listProducts'),
    createProduct:  (payload: any)                       => ipcRenderer.invoke('manage:createProduct', payload),
    updateProduct:  (id: string, patch: any)             => ipcRenderer.invoke('manage:updateProduct', { id, patch }),
    listCategories: ()                                   => ipcRenderer.invoke('manage:listCategories'),
    createCategory: (payload: any)                       => ipcRenderer.invoke('manage:createCategory', payload),
    updateCategory: (id: string, patch: any)             => ipcRenderer.invoke('manage:updateCategory', { id, patch }),
    bulkProducts:       (rows: any[])               => ipcRenderer.invoke('manage:bulkProducts', rows),
    listCombos:         ()                          => ipcRenderer.invoke('manage:listCombos'),
    createCombo:        (payload: any)              => ipcRenderer.invoke('manage:createCombo', payload),
    updateCombo:        (id: string, patch: any)    => ipcRenderer.invoke('manage:updateCombo', { id, patch }),
    setComboItems:      (id: string, items: any[])  => ipcRenderer.invoke('manage:setComboItems', { id, items }),
    listModifierGroups:  (productId: string) => ipcRenderer.invoke('manage:listModifierGroups', productId),
    createModifierGroup: (payload: any) => ipcRenderer.invoke('manage:createModifierGroup', payload),
    deleteModifierGroup: (id: string) => ipcRenderer.invoke('manage:deleteModifierGroup', id),
    listVariantGroups:  (productId: string)         => ipcRenderer.invoke('manage:listVariantGroups', productId),
    createVariantGroup: (payload: any)              => ipcRenderer.invoke('manage:createVariantGroup', payload),
    deleteVariantGroup: (id: string)                => ipcRenderer.invoke('manage:deleteVariantGroup', id),
    listStaff:      ()                                   => ipcRenderer.invoke('manage:listStaff'),
    listRoles:      ()                                   => ipcRenderer.invoke('manage:listRoles'),
    createStaff:    (payload: any)                       => ipcRenderer.invoke('manage:createStaff', payload),
    updateStaff:    (id: string, patch: any)             => ipcRenderer.invoke('manage:updateStaff', { id, patch }),
    getReceiptText: ()                                   => ipcRenderer.invoke('manage:getReceiptText'),
    setReceiptText: (header: string, footer: string)     => ipcRenderer.invoke('manage:setReceiptText', { header, footer }),
  },

  manager: {
    salesSummary:   () => ipcRenderer.invoke('manager:salesSummary'),
    topProducts:    () => ipcRenderer.invoke('manager:topProducts'),
    recentOrders:   () => ipcRenderer.invoke('manager:recentOrders'),
    stockLevels:    () => ipcRenderer.invoke('manager:stockLevels'),
    fuelSales:      () => ipcRenderer.invoke('manager:fuelSales'),
    pumpStatus:     () => ipcRenderer.invoke('manager:pumpStatus'),
    tableOccupancy: () => ipcRenderer.invoke('manager:tableOccupancy'),
    branchReport:   () => ipcRenderer.invoke('manager:branchReport'),
    priceList:        ()                                          => ipcRenderer.invoke('manager:priceList'),
    setBranchPrice:   (product_id: string, price: number)         => ipcRenderer.invoke('manager:setBranchPrice', { product_id, price }),
    clearBranchPrice: (product_id: string)                        => ipcRenderer.invoke('manager:clearBranchPrice', { product_id }),
  },

  expense: {
    categories: () => ipcRenderer.invoke('expense:categories'),
    create: (payload: { description: string; amount: number; expense_category_id?: string; paid_by?: string }) =>
              ipcRenderer.invoke('expense:create', payload),
    list: () => ipcRenderer.invoke('expense:list'),
  },
});
