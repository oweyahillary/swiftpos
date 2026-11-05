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
}
