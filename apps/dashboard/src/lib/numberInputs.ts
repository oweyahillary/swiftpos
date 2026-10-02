/**
 * numberInputs.ts — 0.6.23: a number field never changes by itself.
 *
 * Owner, on the End Shift screen: "remove the feature were scroll up or down reduces or increases the value it can mess
 * the cashier". A browser changes a FOCUSED <input type="number"> when the mouse wheel turns over it — a counted cash
 * figure could move by a few shillings while the cashier scrolls the panel. This takes focus off the field for that
 * wheel turn (the page still scrolls); the spinner arrows are hidden in the app's CSS. ONE file: shared/numberInputs.ts,
 * copied to the till and the web (scripts/check-shared-sync.mjs).
 */
export function stopWheelOnNumberInputs(doc: Document): () => void {
  const onWheel = (e: Event) => {
    const t = e.target as HTMLInputElement | null;
    if (t && t.tagName === 'INPUT' && t.type === 'number' && doc.activeElement === t) t.blur();
  };
  doc.addEventListener('wheel', onWheel, { capture: true, passive: true });
  return () => doc.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
}
