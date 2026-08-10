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

  day: {
    gate:      () => ipcRenderer.invoke('day:gate'),
    current:   () => ipcRenderer.invoke('day:current'),
    summary:   () => ipcRenderer.invoke('day:summary'),
    isManager: () => ipcRenderer.invoke('day:isManager'),
    conflicts: () => ipcRenderer.invoke('day:conflicts'),
    retryConflict: (shiftId: string) => ipcRenderer.invoke('day:retryConflict', { shiftId }),
    close:     (countedCash: number, notes?: string) =>
      ipcRenderer.invoke('day:close', { countedCash, notes }),
  },
  branchClose: {
    overview: () => ipcRenderer.invoke('branchClose:overview'),
    closeTill: (device_id: string, counted_cash: number, notes?: string) =>
      ipcRenderer.invoke('branchClose:closeTill', { device_id, counted_cash, notes }),
  },
  print: {
    list: () => ipcRenderer.invoke('print:list'),
    shares: () => ipcRenderer.invoke('print:shares'),
    preview: (opts: any) => ipcRenderer.invoke('print:preview', opts),
    probe: (deviceName: string) => ipcRenderer.invoke('print:probe', deviceName),
    geometry: (deviceName: string) => ipcRenderer.invoke('print:geometry', deviceName),
    html: (opts: { html: string; deviceName: string; paperWidthMm: 58 | 80; copies: number }) =>
      ipcRenderer.invoke('print:html', opts),
  },

  config: {
    get:            ()             => ipcRenderer.invoke('config:get'),
    isConfigured:   ()             => ipcRenderer.invoke('config:isConfigured'),
    save:           (patch: any)   => ipcRenderer.invoke('config:save', patch),
    clear:          ()             => ipcRenderer.invoke('config:clear'),
    // Read-only terminal identity, for display. Lives here with the other
    // device:* calls rather than in a namespace of its own.
    identity:       ()             => ipcRenderer.invoke('device:identity'),
    resetPreview:   ()             => ipcRenderer.invoke('device:resetPreview'),
    reset:          (force?: boolean) => ipcRenderer.invoke('device:reset', { force }),
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
    query:        (sql: string)   => ipcRenderer.invoke('tech:query', { sql }),
    backupNow:    ()              => ipcRenderer.invoke('tech:backupNow'),
    maintenance:  ()              => ipcRenderer.invoke('tech:maintenance'),
    promoteToNode:()              => ipcRenderer.invoke('tech:promoteToNode'),
    setNodeUrl:   (url: string)   => ipcRenderer.invoke('tech:setNodeUrl', { url }),
  },

  // Held orders (restaurant tabs). Backed by SQLite in the main process since
  // 2026-08-08 — previously renderer localStorage, where a truncated write
  // silently reported zero open tables.
  held: {
    list:   ()                => ipcRenderer.invoke('held:list'),
    hold:   (order: unknown)  => ipcRenderer.invoke('held:hold', order),
    recall: (id: string)      => ipcRenderer.invoke('held:recall', { id }),
    remove: (id: string)      => ipcRenderer.invoke('held:delete', { id }),
    // One-time migration of the legacy localStorage blob. Idempotent.
    importLegacy: (orders: unknown[]) => ipcRenderer.invoke('held:import', { orders }),
  },

  shift: {
    current: ()                                                          => ipcRenderer.invoke('shift:current'),
    open:    (opening_float: number, drawer_label?: string)              => ipcRenderer.invoke('shift:open', { opening_float, drawer_label }),
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
    updateVariantGroup: (id: string, patch: any)    => ipcRenderer.invoke('manage:updateVariantGroup', { id, patch }),
    deleteVariantGroup: (id: string)                => ipcRenderer.invoke('manage:deleteVariantGroup', id),
    createVariantOption:(payload: any)              => ipcRenderer.invoke('manage:createVariantOption', payload),
    updateVariantOption:(id: string, patch: any)    => ipcRenderer.invoke('manage:updateVariantOption', { id, patch }),
    deleteVariantOption:(id: string)                => ipcRenderer.invoke('manage:deleteVariantOption', id),
    // Stations — this entire block was MISSING while the UI, the types, the
    // handlers, the local mirrors, the pull sync, the server routes, and the
    // Postgres migration all existed. The screen crashed on its first call
    // ("$.manage.createStation is not a function") and the kitchen could not
    // be routed at all. check-ipc-parity.mjs now fails CI on this class.
    listStations:         ()                             => ipcRenderer.invoke('manage:listStations'),
    unassignedCategories: ()                             => ipcRenderer.invoke('manage:unassignedCategories'),
    createStation:        (payload: any)                 => ipcRenderer.invoke('manage:createStation', payload),
    updateStation:        (id: string, patch: any)       => ipcRenderer.invoke('manage:updateStation', { id, patch }),
    setStationCategories: (id: string, categoryIds: string[]) => ipcRenderer.invoke('manage:setStationCategories', { id, categoryIds }),
    deleteStation:        (id: string)                   => ipcRenderer.invoke('manage:deleteStation', id),
    listStaff:      ()                                   => ipcRenderer.invoke('manage:listStaff'),
    listRoles:      ()                                   => ipcRenderer.invoke('manage:listRoles'),
    createStaff:    (payload: any)                       => ipcRenderer.invoke('manage:createStaff', payload),
    updateStaff:    (id: string, patch: any)             => ipcRenderer.invoke('manage:updateStaff', { id, patch }),
    getReceiptText: ()                                   => ipcRenderer.invoke('manage:getReceiptText'),
    setReceiptText: (header: string, footer: string)     => ipcRenderer.invoke('manage:setReceiptText', { header, footer }),
  },

  manager: {
    // `range` optional: omitted keeps the original today-only behaviour.
    salesSummary:   (range?: any) => ipcRenderer.invoke('manager:salesSummary', range),
    topProducts:    (range?: any) => ipcRenderer.invoke('manager:topProducts', range),
    recentOrders:   (range?: any) => ipcRenderer.invoke('manager:recentOrders', range),
    reportScope:    ()            => ipcRenderer.invoke('manager:reportScope'),
    resolveRange:   (range: any)  => ipcRenderer.invoke('manager:resolveRange', range),
    exportCsv:      (req: any)    => ipcRenderer.invoke('manager:exportCsv', req),
    dailyReport:    (req?: any)   => ipcRenderer.invoke('manager:dailyReport', req),
    stockLevels:    () => ipcRenderer.invoke('manager:stockLevels'),
    fuelSales:      () => ipcRenderer.invoke('manager:fuelSales'),
    pumpStatus:     () => ipcRenderer.invoke('manager:pumpStatus'),
    tableOccupancy: () => ipcRenderer.invoke('manager:tableOccupancy'),
    branchReport:   () => ipcRenderer.invoke('manager:branchReport'),
    priceList:        ()                                          => ipcRenderer.invoke('manager:priceList'),
    setBranchPrice:   (product_id: string, price: number)         => ipcRenderer.invoke('manager:setBranchPrice', { product_id, price }),
    clearBranchPrice: (product_id: string)                        => ipcRenderer.invoke('manager:clearBranchPrice', { product_id }),
  },

  // ── ESC/POS printing (the thermal spool subsystem) ────────────────────────
  // Namespaced escpos:* rather than print:*, because print:* belongs to the
  // legacy HTML print path in ipcHandlers.ts and print:preview exists in both.
  // Two ipcMain.handle calls on one channel throw at startup.
  escpos: {
    assignments: ()                  => ipcRenderer.invoke('escpos:assignments'),
    assign:      (a: unknown)        => ipcRenderer.invoke('escpos:assign', a),
    unassign:    (stationId: string) => ipcRenderer.invoke('escpos:unassign', stationId),
    status:      ()                  => ipcRenderer.invoke('escpos:status'),
    // Per-terminal thermal switch. Off by default; see main/escposBridge.ts.
    enabled:     ()                  => ipcRenderer.invoke('escpos:enabled'),
    setEnabled:  (on: boolean)       => ipcRenderer.invoke('escpos:setEnabled', on),
    // "Will a ticket of this kind actually come out here?" — not merely "is the
    // switch on". A terminal can have thermal enabled and no receipt station.
    canPrint:    (kind: 'kitchen' | 'dispatch' | 'receipt') =>
                   ipcRenderer.invoke('escpos:canPrint', kind),
    // Kitchen + dispatch tickets, at the moment the order is SENT — not when
    // it is paid. See main/escposBridge.ts.
    printProduction: (payload: unknown) =>
                   ipcRenderer.invoke('escpos:printProduction', payload),
    // The list the PRINTER applies, so a preview cannot disagree with it.
    kitchenExclusions: () => ipcRenderer.invoke('escpos:kitchenExclusions'),
    reprintReceipt: () => ipcRenderer.invoke('escpos:reprintReceipt'),
    printShiftReport: (data: unknown) => ipcRenderer.invoke('escpos:printShiftReport', data),
    retry:       (id: string)        => ipcRenderer.invoke('escpos:retry', id),
    preview:     (ctx: unknown)      => ipcRenderer.invoke('escpos:preview', ctx),
    test:        (ctx: unknown, target: string) => ipcRenderer.invoke('escpos:test', ctx, target),
    // Push, not poll: the spool tells the screen when the queue moves.
    // Returns its own unsubscribe so a React effect can clean up.
    onChanged:   (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on('escpos:changed', h);
      return () => { ipcRenderer.removeListener('escpos:changed', h); };
    },
  },

  expense: {
    categories: () => ipcRenderer.invoke('expense:categories'),
    create: (payload: { description: string; amount: number; expense_category_id?: string; paid_by?: string }) =>
              ipcRenderer.invoke('expense:create', payload),
    list: () => ipcRenderer.invoke('expense:list'),
  },
});
