import { useBusiness } from '../context/BusinessContext';
import { businessTerms, type BusinessTerms } from '@zaptill/core/businessTerms';

// Vertical-aware wording so the UI speaks the right dialect per business type:
// a restaurant/café sees "Menu Items / Menu Sections / Set Meals", while a
// minimart/retail business sees "Products / Categories / Combos". A573: the words
// themselves now live in lib/businessTerms.ts (a copy of shared/businessTerms.ts, the
// till reads the same file) — with Menus / Departments / Groups for the grouping of
// categories. Nav labels, page titles and buttons all read from here.

export type TermKey =
  | 'product'  | 'products'
  | 'category' | 'categories'
  | 'promotion'| 'promotions'
  | 'combo'    | 'combos'
  | 'inventory'
  | 'menu'     | 'menus';

export interface Terminology {
  isFood: boolean;
  /** Title-case term, e.g. term('products') -> "Menu Items" */
  term: (key: TermKey) => string;
  /** Lower-case term, handy for inline sentences/placeholders. */
  lower: (key: TermKey) => string;
  /** A573: every word for this business type (examples, setup label …). */
  terms: BusinessTerms;
}

export function useTerm(): Terminology {
  const { business } = useBusiness();
  // Unknown type (still loading) defaults to food wording, matching the nav.
  const terms = businessTerms(business?.type);
  const term = (key: TermKey) => terms[key];
  const lower = (key: TermKey) => terms[key].toLowerCase();
  return { isFood: terms.food, term, lower, terms };
}
