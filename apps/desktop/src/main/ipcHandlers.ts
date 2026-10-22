// IPC Handlers — registered in main process, called from renderer via preload.ts
//
// Channels:
//   auth:enrolDevice   → POST /api/auth/enrol/redeem, store session in SQLite
//                        (owner email/password login RETIRED — A158)
//   auth:getSession   → return current session row
//   pos:init          → return products + categories + branchId from SQLite
//   pos:getVariants   → return variant groups + options for a product
//   pos:getModifiers  → return modifier groups + options for a product
//   order:create      → write order to SQLite + enqueue for sync
//   sync:trigger      → run syncAll()
//   sync:status       → return { online, pendingCount }
//
// D10 (2026-10-21): the handlers live in ipc/*.ts, one module per area; this file builds the validating `handle`
// and the shared helpers (ipc/shared.ts) once, then registers every module in the order the channels always
// registered in.

import { ipcMain } from 'electron';
import { installValidatedHandle } from './ipcGuard';
import { createIpcShared } from './ipc/shared';
import { registerJoinHandlers } from './ipc/join';
import { registerHeldHandlers } from './ipc/held';
import { registerSignInHandlers } from './ipc/signIn';
import { registerCatalogueHandlers } from './ipc/catalogue';
import { registerSaleHandlers } from './ipc/sale';
import { registerPrinterHandlers } from './ipc/printers';
import { registerDeviceHandlers } from './ipc/device';
import { registerDayCloseHandlers } from './ipc/dayClose';
import { registerShiftHandlers, registerShiftReportHandlers } from './ipc/shifts';
import { registerCreditHandlers } from './ipc/credit';
import { registerKitchenHandlers } from './ipc/kitchen';
import { registerMenuHandlers, registerMenuOptionHandlers } from './ipc/menu';
import { registerWastageHandlers, registerTransferHandlers } from './ipc/stock';
import { registerBranchStockHandlers } from './ipc/branchStock';   // A564
import { registerLabelHandlers } from './ipc/labels';   // A571
import { registerStaffHandlers, registerStaffUpdateHandlers } from './ipc/staff';
import { registerMonthlyHandlers } from './ipc/monthly';
import { registerBranchSettingsHandlers } from './ipc/branchSettings';
import { registerReportHandlers, registerBranchReportHandlers } from './ipc/reports';
import { registerExpenseHandlers } from './ipc/expenses';
import { registerReversalHandlers } from './ipc/reversals';
import { registerTechHandlers } from './ipc/tech';

export function registerIpcHandlers() {


  // D7: every channel below is registered through `handle`, which validates the
  // payload against ipcSchemas.ts before the handler runs (installValidatedHandle).
  // A channel with no registry entry throws at the boundary; check-ipc-validation
  // fails the build first, so it can't ship. This is why the handlers no longer
  // need per-channel payload boilerplate.
  const handle = installValidatedHandle(ipcMain);
  const ctx = createIpcShared(handle);

  // The order below is the registration order from before the split — keep it (a module with two register functions
  // is called twice, at the place its channels always registered).
  registerJoinHandlers(ctx);
  registerHeldHandlers(ctx);
  registerSignInHandlers(ctx);
  registerCatalogueHandlers(ctx);
  registerSaleHandlers(ctx);
  registerPrinterHandlers(ctx);
  registerDeviceHandlers(ctx);
  registerDayCloseHandlers(ctx);
  registerShiftHandlers(ctx);
  registerCreditHandlers(ctx);
  registerKitchenHandlers(ctx);
  registerShiftReportHandlers(ctx);   // shifts.ts — after the kitchen, as before the split
  registerMenuHandlers(ctx);
  registerWastageHandlers(ctx);   // stock.ts
  registerMenuOptionHandlers(ctx);   // menu.ts
  registerStaffHandlers(ctx);
  registerTransferHandlers(ctx);   // stock.ts
  registerBranchStockHandlers(ctx);   // A564: other branches' stock, and asking them for it
  registerLabelHandlers(ctx);   // A571: barcode labels on any printer and any label size
  registerMonthlyHandlers(ctx);
  registerStaffUpdateHandlers(ctx);   // staff.ts
  registerBranchSettingsHandlers(ctx);
  registerReportHandlers(ctx);
  registerExpenseHandlers(ctx);
  registerReversalHandlers(ctx);
  registerTechHandlers(ctx);
  registerBranchReportHandlers(ctx);   // reports.ts
}
