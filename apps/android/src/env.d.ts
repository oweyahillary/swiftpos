/// <reference types="vite/client" />

/** The app's version from package.json, for a browser preview (on Android the installed APK's own versionName is used). */
declare const __APP_VERSION__: string;

/**
 * Till stage 1: the web POS screens (apps/dashboard/src/shopPos/ShopPosScreens.tsx), mapped by vite.config.ts. Declared
 * here, narrowly, so this app's strict type-check never reaches into the dashboard's own files (the dashboard checks them
 * with its own settings). tests/android-till-stage1.test.mjs checks the dashboard file exports these three.
 */
declare module '@zaptill/dashboard-pos' {
  import type { ComponentType } from 'react';
  export const ShopPosSelling: ComponentType;
  export function setShopPosHost(host: {
    terminal: { device_id: string; terminal_code: string | null; device_label: string | null };
    printBytes: (target: string, bytes: Uint8Array) => Promise<void>;
    printOrder: (job: 'receipt' | 'kitchen' | 'proforma' | 'void', order: Record<string, unknown>) =>
      Promise<{ printed: number; failed: number; configured: number; problem: string | null } | null>;
  } | null): void;
  export function storeCashierSession(s: {
    token: string; refreshToken: string; staffId: string; staffName: string; role: string;
    branchId: string; branchName: string; businessType: string; currency: string; permissions: Record<string, boolean>;
  }): void;
  // Till stage 3b: the shared held-orders (tabs) host, installed only when this POS joined a branch server.
  interface BranchTab {
    id: string; order_number: string; label: string; order_type: string; table_number: string;
    cart: unknown; opened_by: string; last_changed_by: string | null; locked_by: string | null; locked: boolean;
  }
  type BranchClaim = { outcome: 'claimed'; tab: BranchTab; stole: boolean } | { outcome: 'locked'; lockedBy: string } | { outcome: 'unreachable' };
  type BranchEdit = { outcome: 'ok'; tab: BranchTab } | { outcome: 'lost'; lockedBy?: string } | { outcome: 'unreachable' };
  export function setBranchTabsHost(host: {
    listTabs: (branchId: string) => Promise<BranchTab[]>;
    registerTab: (t: { id: string; branch_id: string; order_number: string; label: string; order_type: string; table_number?: string; cart: unknown; opened_by: string }) => Promise<void>;
    claimTab: (id: string, name: string) => Promise<BranchClaim>;
    forceClaim: (id: string, name: string) => Promise<BranchClaim>;
    updateTab: (id: string, cart: unknown, label?: string) => Promise<BranchEdit>;
    releaseTab: (id: string) => Promise<void>;
    deleteTab: (id: string, reason: 'charged' | 'cleared') => Promise<void>;
  } | null): void;
}
