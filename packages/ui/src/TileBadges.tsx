/**
 * TileBadges — the words on a product tile, the same on both POS (owner decision 2026-11-04, sentence case): "Later" (its
 * menu is closed, shown because Later is on — A580), "Sold out" (A563; not with Later), and "Options" on an item that
 * asks for a size or add-ons (the desktop showed ⚙, the web "options").
 *
 * Each app passes its look (./paint.ts): where each badge sits on its tile.
 */
import { painted, type Paint } from './paint';

export const TILE_WORDS = { later: 'Later', soldOut: 'Sold out', options: 'Options' } as const;

export interface TileBadgesLook {
  later: Paint;
  soldOut: Paint;
  options: Paint;
}

export default function TileBadges({ later, soldOut, options, look }: {
  later: boolean;
  soldOut: boolean;
  options: boolean;
  look: TileBadgesLook;
}) {
  return (
    <>
      {later && <span data-testid="badge-later" {...painted(look.later)}>{TILE_WORDS.later}</span>}
      {soldOut && !later && <span data-testid="badge-sold-out" {...painted(look.soldOut)}>{TILE_WORDS.soldOut}</span>}
      {options && <span data-testid="badge-options" {...painted(look.options)}>{TILE_WORDS.options}</span>}
    </>
  );
}
