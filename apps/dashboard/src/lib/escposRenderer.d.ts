// Types for the generated escposRenderer.js (built from shared/printing via
// scripts/build-escpos-renderer.mjs). Renders a receipt to ESC/POS in the browser.
import type { ReceiptOrder, ReceiptBusinessConfig } from './buildReceiptOrder';
export function renderEscPos(
  order: ReceiptOrder,
  business: ReceiptBusinessConfig,
  paperWidth: 58 | 80,
): Uint8Array;
