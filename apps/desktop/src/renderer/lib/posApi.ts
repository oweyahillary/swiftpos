// Renderer-side API — calls window.swiftpos.* (IPC via preload.ts)
// Shape mirrors the web dashboard's api.ts so shared logic stays consistent.

export interface StaffSession {
  staff: { id: string; name: string } | null;
  role: string | null;
  permissions: Record<string, boolean>;
  branchId: string;
  branchName: string | null;
}

export type DeployMode = 'cloud' | 'local';

export interface DiningTable {
  id: string;
  name: string;
  capacity: number;
  sort_order: number;
  slot_type: 'dining' | 'parking_bay';
  pos_x: number | null;
  pos_y: number | null;
  zone: string | null;
  shape: 'rect' | 'circle' | null;
}

export interface Pump {
  id: string;
  name: string;
  status: string;
  sort_order: number;
  fuel_product_id: string | null;
  fuel_product_name: string | null;
  price_per_litre: number | null;
}

export type DeviceRole = 'till' | 'node';

export interface TechSession {
  techId: string; techName: string; branchId: string;
  startedAt: number; expiresAt: number; tokenHash: string;
}

export interface TechStatus {
  device: {
    device_id: string | null; device_name: string | null; device_role: DeviceRole;
    branch_id: string | null; deploy_mode: string | null; server_url: string | null; node_url: string | null;
  };
  sync: { online?: boolean; pending: number; failed: number; lastOrder: string | null; [k: string]: any };
}

export interface DeviceConfig {
  deploy_mode: DeployMode;
  server_url: string;
  branch_id: string | null;
  business_type: string | null;
  device_name: string | null;
  device_id: string | null;
  device_role: DeviceRole;
  node_url: string | null;
  configured: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  reachable: boolean;
  status?: number;
  error?: string;
}

export interface ZReport {
  shift: {
    id: string;
    opened_at: string;
    closed_at: string | null;
    status: string;
    cashier_id: string | null;
    cashier_name: string;
    opening_float: number;
    closing_float: number | null;
    expected_cash: number;
    cash_variance: number | null;
    notes: string | null;
  };
  byMethod: { method: string; amount: number; orders: number }[];
  totals: {
    orderCount: number;
    grossSales: number;
    voidCount: number;
    cashSales: number;
    floatIn: number;
    floatOut: number;
    expectedCash: number;
  };
  businessName: string;
  currency: string;
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
}

declare global {
  interface Window {
    swiftpos: {
      version: string;
      platform: string;
      auth: {
        login: (email: string, password: string) => Promise<{ user: any; business: any }>;
        logout: () => Promise<boolean>;
        getSession: () => Promise<{ user: any; business: any } | null>;
        listBranches: () => Promise<{ id: string; name: string; desktop_licensed: boolean }[]>;
        verifyPin: (pin: string, branch_id: string) => Promise<StaffSession>;
        getStaffSession: () => Promise<StaffSession | null>;
        clearStaffSession: () => Promise<boolean>;
      };
      pos: {
        init: () => Promise<{ products: any[]; categories: any[]; branchId: string | null }>;
        getVariants: (productId: string) => Promise<any[]>;
        getModifiers: (productId: string) => Promise<any[]>;
        getTables: () => Promise<DiningTable[]>;
        getPumps: () => Promise<Pump[]>;
      };
      order: {
        create: (payload: any) => Promise<{ orderId: string }>;
        void:   (orderId: string, reason: string, supervisor_pin?: string) => Promise<{ ok: boolean }>;
      };
      sync: {
        trigger: () => Promise<{ pulled: boolean; pushed: number; errors: string[] }>;
        status: () => Promise<{ online: boolean; pendingCount: number; failedCount: number }>;
        retryFailed: () => Promise<{ requeued: number; pushed: number; errors: string[] }>;
        notifyNetworkChange: (online: boolean) => Promise<{ online: boolean; pendingCount: number; failedCount: number }>;
      };
      print: {
        list: () => Promise<PrinterInfo[]>;
        html: (opts: { html: string; deviceName: string; paperWidthMm: 58 | 80; copies: number }) => Promise<{ ok: boolean; error?: string }>;
      };
      config: {
        get: () => Promise<DeviceConfig | null>;
        isConfigured: () => Promise<boolean>;
        save: (patch: Partial<DeviceConfig>) => Promise<DeviceConfig>;
        clear: () => Promise<boolean>;
        testConnection: (url: string) => Promise<ConnectionTestResult>;
      };
      tech: {
        checkReveal:  (code: string)  => Promise<{ ok: boolean }>;
        openSession:  (token: string) => Promise<{ ok: true; session: TechSession } | { ok: false; error: string }>;
        getSession:   () => Promise<TechSession | null>;
        closeSession: () => Promise<{ ok: boolean }>;
        logAction:    (action: string, detail?: any) => Promise<{ ok: boolean }>;
        status:       () => Promise<TechStatus>;
        adoptFromNode:() => Promise<{ ok: true; session: TechSession } | { ok: false }>;
      };
      shift: {
        current: () => Promise<ZReport | null>;
        open: (opening_float: number) => Promise<ZReport | null>;
        float: (type: 'float_in' | 'float_out', amount: number, reason?: string) => Promise<ZReport | null>;
        close: (closing_float: number, notes?: string) => Promise<ZReport>;
        zreport: (shiftId: string) => Promise<ZReport>;
      };
      manager: {
        salesSummary:    () => Promise<any>;
        topProducts:     () => Promise<any[]>;
        recentOrders:    () => Promise<any[]>;
        stockLevels:     () => Promise<any[]>;
        fuelSales:       () => Promise<any>;
        pumpStatus:      () => Promise<any[]>;
        tableOccupancy:  () => Promise<any[]>;
        branchReport:    () => Promise<{ salesSummary: any; topProducts: any[]; recentOrders: any[]; stockLevels: any[]; source: 'node' | 'local' | 'local_fallback' }>;
        priceList:        () => Promise<{ product_id: string; product_name: string; category_name: string | null; base_price: number; branch_price: number | null; effective_price: number; pending: boolean }[]>;
        setBranchPrice:   (product_id: string, price: number) => Promise<{ ok: true }>;
        clearBranchPrice: (product_id: string) => Promise<{ ok: true }>;
      };
      expense: {
        categories: () => Promise<{ id: string; name: string }[]>;
        create: (p: { description: string; amount: number; expense_category_id?: string; paid_by?: string }) => Promise<{ id: string }>;
        list: () => Promise<any[]>;
      };
    };
  }
}

export const posApi = window.swiftpos;
