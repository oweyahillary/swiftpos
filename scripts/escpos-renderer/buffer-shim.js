// escpos.ts calls Buffer.from(numberArray); in the browser Buffer is undefined.
// This shim provides just that, returning a Uint8Array (what we base64 + send).
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = { from: (a) => Uint8Array.from(a) };
}
