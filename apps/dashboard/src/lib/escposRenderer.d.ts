// Types for the generated escposRenderer.js (built from shared/printing via
// scripts/build-escpos-renderer.mjs). Renders a receipt to ESC/POS in the browser.
import type { ReceiptOrder, ReceiptBusinessConfig } from './buildReceiptOrder';
type Render = (order: ReceiptOrder, business: ReceiptBusinessConfig, paperWidth: 58 | 80) => Uint8Array;
export const renderEscPos: Render;         // customer receipt (back-compat alias)
export const renderReceiptEscPos: Render;  // customer receipt
export const renderKitchenEscPos: Render;  // kitchen ticket (all items, no prices)
export const renderDispatchEscPos: Render; // dispatch/packaging ticket
