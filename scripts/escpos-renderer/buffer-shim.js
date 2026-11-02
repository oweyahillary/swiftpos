// escpos.ts calls Buffer.from(numberArray); in the browser Buffer is undefined.
// This shim provides just that, returning a Uint8Array (what we base64 + send).
//
// 2026-10-31: injected as a module export (esbuild --inject replaces the bundle's own references to the global `Buffer`
// with this binding), never written onto globalThis. Before, it gave the whole page a global Buffer with only from(), and a
// library that trusts a global Buffer (recharts' es-toolkit isBuffer: `globalThis.Buffer.isBuffer(x)`) crashed the
// Analytics page once a receipt had loaded: "Buffer.isBuffer is not a function".
const PrinterBuffer = typeof globalThis.Buffer !== 'undefined' ? globalThis.Buffer : { from: (a) => Uint8Array.from(a) };
export { PrinterBuffer as Buffer };
