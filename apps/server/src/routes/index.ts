import { Router } from 'express';

import authRoutes          from './auth';
import enrolRoutes         from './enrol';
import businessRoutes      from './business';
import onboardingRoutes    from './onboarding';
import categoriesRoutes    from './categories';
import menusRoutes         from './menus';          // A537: Food, Soft drinks, Alcohol, Tea … above the categories
import stationsRoutes      from './stations';
import productsRoutes      from './products';
import posRoutes           from './pos';
import desktopUpdateRoutes from './desktopUpdate';   // A348: per-business desktop update feed
import variantsRoutes      from './variants';
import modifiersRoutes     from './modifiers';
import ordersRoutes        from './orders';
import inventoryRoutes     from './inventory';
import kitchenRoutes       from './kitchen';
import staffRoutes         from './staff';
import reportsExportRoutes from './reports-export';
import reportsDailyRoutes  from './reports-daily';
import reportsMonthlyRoutes from './reports-monthly';   // A455
import reportsRoutes       from './reports';
import analyticsRoutes     from './analytics';   // A549
import attendanceRoutes    from './attendance';  // A599
import lossAlertsRoutes    from './lossAlerts';  // A576
import loyaltyRoutes       from './loyalty';
import creditRoutes        from './credit';
import notificationsRoutes from './notifications';
import branchesRoutes      from './branches';
import discountsRoutes     from './discounts';
import paymentMethodsRoutes from './payment-methods';
import promotionsRoutes    from './promotions';
import offersRoutes        from './offers';   // A445
import changesRoutes       from './changes';   // A448
import flagsRoutes         from './flags';
import versionRoutes       from './version';   // 0.6.28: which release the cloud runs
import { adminVersionRouter } from './version';
import tablesRoutes        from './tables';
import shiftsRoutes        from './shifts';
import dayCloseRoutes      from './day-close';
import stockRoutes         from './stock';
import stockTakeRoutes     from './stockTakes';   // A394
import payablesRoutes      from './payables';     // A395
import wastageRoutes       from './wastage';      // A399
import batchesRoutes       from './batches';      // A413
import expensesRoutes      from './expenses';
import recipesRoutes       from './recipes';
import printersRoutes      from './printers';
import mpesaRoutes         from './mpesa';
import webhooksRoutes      from './webhooks';
import { fuelTanksRouter, pumpsRouter } from './fueltanks';
import combosRoutes        from './combos';
import reservationsRoutes  from './reservations';
import qrRoutes            from './qr';
import tenantRoutes        from './tenant';   // A378: a client's sign-in address (name + logo, public)
import etimsRoutes         from './etims';
import adminRoutes         from './admin';
import techRoutes          from './tech';
import syncRoutes          from './sync';
import backfillRoutes      from './backfill';   // A602
import devicesRoutes       from './devices';
import parkingRoutes       from './parking';
import controlsRoutes      from './controls';   // A490: the owner's business options
import branchPricesRoutes  from './branch-prices';
import supportRoutes       from './support';        // A519: a till's log to support; terminal codes in use
import supportAdminRoutes  from './supportAdmin';   // A519: the admin portal reads them
import logRequestsAdminRoutes from './logRequestsAdmin';   // A533: support pulls a till's log from the admin portal
import tillsDaysRoutes     from './tills-days';      // A523: the owner's Tills & days page
import tillsDaysAdminRoutes from './tillsDaysAdmin'; // A523: the same page in the admin portal
import opsRoutes           from './ops';            // A525: the GitHub workflows post the deploy check and the scan
import opsAdminRoutes      from './opsAdmin';       // A525: the admin portal's System page reads them
import adminInstallerRoutes from './adminInstaller';   // A570: Download ZapTill, through the cloud
import cloudPlanAdminRoutes from './cloudPlanAdmin';   // A581: the cloud payment plan
import billingDetailsAdminRoutes from './billingDetailsAdmin';   // A612: ZapTill's billing details and prices
import { forgetOnWrite }   from '../lib/forgetOnWrite';   // A528
import { ringDrawersOnWrite } from '../lib/drawerBell';   // A535
import branchDrawersRoutes from './branchDrawers';       // A535: a branch server asks about every drawer of its branch at once

const router = Router();

// A528: a write here drops what the polled answers remember for the business (lib/forgetOnWrite.ts) — a web edit
// reaches the tills' catalogue-version / branch-staff at once, and blocking a till or a person takes effect on the very
// next request (the sign-in check remembers rows 30 s). Before the routers, so it sees every write they handle.
router.use(['/products', '/categories', '/variants', '/modifiers', '/combos', '/business', '/controls', '/flags',
  '/tables', '/branches', '/printers', '/stations', '/branch-prices', '/stock-takes', '/offers', '/promotions',
  '/onboarding', '/payment-methods', '/menus'], forgetOnWrite({ catalogue: true }));
router.use(['/business', '/controls'], forgetOnWrite({ people: true }));   // the owner, the business's options
router.use(['/staff', '/changes'], forgetOnWrite({ catalogue: true, staff: true, people: true }));
router.use(['/auth/set-pin', '/auth/me'], forgetOnWrite({ staff: true }));   // a PIN changed: the branch's staff list
router.use(['/devices', '/tills-days'], forgetOnWrite({ staff: true, tills: true }));
router.use(['/admin'], forgetOnWrite({ catalogue: true, staff: true, tills: true, people: true, everyBusiness: true }));
// A535: a stock level changed on the web (a restock, a transfer, wastage) rings the branch at once — a sale's levels ring
// at most every 5 minutes (lib/liveHub.ts). And a drawer changed on the web rings the branch server, which asks
// GET /api/pos/branch-drawers at once (lib/drawerBell.ts) — a till's own drawer writes and the read-only POSTs do not.
router.use(['/inventory', '/stock', '/wastage'], forgetOnWrite({}));
router.use(['/shifts'], ringDrawersOnWrite({ skip: /\/(foreign-cash|foreign-orders|confirmer|confirm-view)$/ }));
router.use(['/orders', '/day-close'], ringDrawersOnWrite({ webOnly: true }));
router.use('/pos/branch-drawers', branchDrawersRoutes);

router.use('/auth',           authRoutes);
router.use('/enrol',          enrolRoutes);
router.use('/branches',       branchesRoutes);
router.use('/discounts',      discountsRoutes);
router.use('/payment-methods', paymentMethodsRoutes);
router.use('/promotions',     promotionsRoutes);
router.use('/offers',         offersRoutes);   // A445
router.use('/changes',        changesRoutes);   // A448
router.use('/combos',         combosRoutes);
router.use('/reservations',   reservationsRoutes);
router.use('/qr',             qrRoutes);
router.use('/tenant',         tenantRoutes);
router.use('/flags',          flagsRoutes);
router.use('/version',        versionRoutes);
router.use('/tables',         tablesRoutes);
router.use('/shifts',         shiftsRoutes);
router.use('/day-close',      dayCloseRoutes);
router.use('/tills-days',     tillsDaysRoutes);   // A523
router.use('/stock',          stockRoutes);
router.use('/stock-takes',    stockTakeRoutes);
router.use('/payables',       payablesRoutes);
router.use('/wastage',        wastageRoutes);    // A399
router.use('/batches',        batchesRoutes);    // A413
router.use('/expenses',       expensesRoutes);
router.use('/recipes',        recipesRoutes);
router.use('/printers',       printersRoutes);
router.use('/business',       businessRoutes);
router.use('/onboarding',     onboardingRoutes);
router.use('/categories',     categoriesRoutes);
router.use('/menus',          menusRoutes);       // A537
router.use('/stations',       stationsRoutes);
router.use('/products',       productsRoutes);
router.use('/branch-prices',  branchPricesRoutes);
router.use('/pos',            posRoutes);
router.use('/desktop-update', desktopUpdateRoutes);
router.use('/variants',       variantsRoutes);
router.use('/modifiers',      modifiersRoutes);
router.use('/orders',         ordersRoutes);
router.use('/inventory',      inventoryRoutes);
router.use('/kitchen',        kitchenRoutes);
router.use('/staff',          staffRoutes);
router.use('/loyalty',        loyaltyRoutes);
router.use('/credit',         creditRoutes);
router.use('/notifications',  notificationsRoutes);
router.use('/webhooks',       webhooksRoutes);
router.use('/mpesa',          mpesaRoutes);
router.use('/fuel-tanks',     fuelTanksRouter);
router.use('/pumps',          pumpsRouter);
router.use('/etims',          etimsRoutes);

// IMPORTANT: reports/export must come before /reports
// Daily / hourly / audit share the same prefix and middleware. Mounted first so
// its specific paths win before the broader export router's handlers.
router.use('/reports/monthly', reportsMonthlyRoutes);   // A455: before /reports, which takes the rest
router.use('/reports/export', reportsDailyRoutes);
router.use('/reports/export', reportsExportRoutes);
router.use('/reports',        reportsRoutes);
router.use('/analytics',      analyticsRoutes);   // A549: Analytics v1 (premium, the 'analytics' flag)
router.use('/attendance',     attendanceRoutes);  // A599: Attendance (premium, the 'attendance' flag) — the web report and the branch server's /node/*
router.use('/loss-alerts',    lossAlertsRoutes);  // A576: the watch list and the owner's loss-prevention settings

router.use('/admin/version',  adminVersionRouter);   // before /admin, which takes the rest of /admin/*
router.use('/admin/support-logs', supportAdminRoutes);   // A519: before /admin, which takes the rest of /admin/*
router.use('/admin/clients', logRequestsAdminRoutes);   // A533: …/:id/log-requests only; the rest falls through to /admin
router.use('/admin/clients', cloudPlanAdminRoutes);   // A581: …/:id/cloud-plan only; the rest falls through to /admin
router.use('/admin/billing-details', billingDetailsAdminRoutes);   // A612
router.use('/admin/tills-days', tillsDaysAdminRoutes);   // A523: before /admin, which takes the rest of /admin/*
router.use('/admin/ops',      opsAdminRoutes);   // A525: before /admin, which takes the rest of /admin/*
router.use('/admin/desktop',  adminInstallerRoutes);   // A570: before /admin, which takes the rest of /admin/*
router.use('/admin',          adminRoutes);
router.use('/tech',           techRoutes);
router.use('/sync/backfill',  backfillRoutes);   // A602: before /sync (its own requireAuth, its own body limit — index.ts)
router.use('/sync',           syncRoutes);
router.use('/devices',        devicesRoutes);
router.use('/parking-sessions', parkingRoutes);
router.use('/controls',       controlsRoutes);   // A490
router.use('/support',        supportRoutes);    // A519
router.use('/ops',            opsRoutes);        // A525: a token, not a user session

export default router;
