/**
 * paint.ts — how a shared screen piece's element is painted by each app (docs/SHARED-COMPONENTS-PLAN.md, batch G).
 *
 * A piece in @zaptill/ui holds the structure and the behaviour once; each app passes its look: class names (a string —
 * the desktop's Tailwind, and the web's where its Tailwind build finds them in the app's own file), or an inline style
 * and / or class names (the web's styles on its theme tokens).
 */
import type { CSSProperties } from 'react';

export type Paint = string | { className?: string; style?: CSSProperties };

/** A Paint as the element's props. */
export function painted(paint: Paint | undefined): { className?: string; style?: CSSProperties } {
  if (paint === undefined) return {};
  return typeof paint === 'string' ? { className: paint } : paint;
}
