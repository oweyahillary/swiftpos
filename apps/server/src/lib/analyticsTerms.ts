/**
 * analyticsTerms.ts — A575: Analytics in each business type's own words, and what to do about two products bought
 * together ("What sells together") in the business's own way of selling. Built on businessTerms.ts (A573), beside it.
 *
 * Kept apart from businessTerms.ts so the till (which has no Analytics) does not carry these words in its first screen.
 * Imports businessTerms.ts only. Copied verbatim to the web dashboard (the Analytics page) and the cloud (the cards)
 * (scripts/check-shared-sync.mjs).
 */
import { businessTypeOf, isFoodService } from './businessTerms';

// ── Analytics in each business's own words ──────────────────────────────────────────────────────────────────────────
//
// A573 left Analytics for later ("Menu engineering", "items on your menu with no cost", "food cost", "kitchen items"). A
// shop reads "Product performance", "items you sell", "cost of sales"; a restaurant or café keeps its words. The tab's
// key stays 'menu' (the cloud's /menu-engineering, the tiles' hooks) — only what is shown changes.

export interface AnalyticsWords {
  /** The area of what each item earns: "Menu engineering" / "Product performance". */
  itemsArea: string;
  /** What that area tells you, in one line. */
  itemsTells: string;
  /** The scatter's title: "Menu engineering matrix" / "Product performance matrix". */
  matrix: string;
  /** "on your menu" / "you sell" — "items on your menu with no cost" / "items you sell with no cost". */
  onYourList: string;
  /** "Food cost" / "Cost of sales" — the cost of what sold ÷ what it sold for. */
  costOfSales: string;
  /** "the food bill" / "what your stock costs" — "a bigger share of the food bill". */
  costBill: string;
  /** "the cost of the food" / "the cost of the goods" — the margin tile. */
  costOf: string;
  /** "the cost of one serving" / "the cost of one item" — the margin's definition. */
  unitCost: string;
  /** "Check the portion or what goes into the top ones" / "Check what you pay for the top ones". */
  thinCheck: string;
  /** "kitchen items" / "items" — items removed after they were sent (a shop sends nothing to a kitchen). */
  removedItems: string;
  /** The voids note: "… plus kitchen items removed after they were sent" / "… plus items removed from a bill". */
  voidsNote: string;
}

export function analyticsWords(raw: string | null | undefined): AnalyticsWords {
  if (isFoodService(raw)) {
    return {
      itemsArea: 'Menu engineering',
      itemsTells: 'Which items earn you money and which only keep the kitchen busy: keep the Stars, check the recipe or portion of the Plowhorses, push the Puzzles, rework the Dogs.',
      matrix: 'Menu engineering matrix',
      onYourList: 'on your menu',
      costOfSales: 'Food cost',
      costBill: 'the food bill',
      costOf: 'the cost of the food',
      unitCost: 'the cost of one serving (the cost price, else the recipe)',
      thinCheck: 'Check the portion or what goes into the top ones',
      removedItems: 'kitchen items',
      voidsNote: 'Voids are voided orders plus kitchen items removed after they were sent.',
    };
  }
  return {
    itemsArea: 'Product performance',
    itemsTells: 'Which products earn you money and which only take up shelf space: keep the Stars in stock and in sight, check what you pay for the Plowhorses, put the Puzzles where customers see them, rethink the Dogs.',
    matrix: 'Product performance matrix',
    onYourList: 'you sell',
    costOfSales: 'Cost of sales',
    costBill: 'what your stock costs',
    costOf: 'the cost of the goods',
    unitCost: 'the cost of one item (its cost price)',
    thinCheck: 'Check what you pay for the top ones',
    removedItems: 'items removed',
    voidsNote: 'Voids are voided orders plus items removed from a bill after it was sent.',
  };
}

/**
 * A575: "What sells together" — what to DO about two products bought together, in the business's own way of selling.
 * Never a price: a restaurant or café pairs them (offer one with the other, or make them a combo), a shop puts them
 * side by side (the same shelf, near the till), a petrol station offers the shop item at the pump when one of them is
 * fuel, a car park or anything else offers them together. `a` is what customers come for, `b` what they add.
 */
export interface TogetherAdvice {
  /** verb first: "Offer Soda 500ml with Chicken Wrap" / "Put Soda 500ml next to Bread" */
  title: string;
  /** what to do, one or two sentences */
  action: string;
  /** the short version for a table row: "Offer as a combo" / "Same shelf or near the till" */
  short: string;
}

export function togetherAdvice(raw: string | null | undefined, a: { name: string; fuel?: boolean }, b: { name: string; fuel?: boolean }): TogetherAdvice {
  const t = businessTypeOf(raw);
  if (isFoodService(raw)) {
    return {
      title: `Offer ${b.name} with ${a.name}`,
      action: `Make them a combo, or remind cashiers and waiters to offer ${b.name} with every ${a.name}.`,
      short: 'Offer together or as a combo',
    };
  }
  if (t === 'petrol_station') {
    if (a.fuel || b.fuel) {
      const shop = a.fuel ? b : a; const fuel = a.fuel ? a : b;
      return {
        title: `Offer ${shop.name} at the pumps`,
        action: `Customers who buy ${fuel.name} often take ${shop.name}: keep some at the pump island and have attendants offer it with every fill-up.`,
        short: 'Offer at the pumps',
      };
    }
    return {
      title: `Put ${b.name} next to ${a.name}`,
      action: `Place them together in the forecourt shop or near the till, and remind cashiers to offer ${b.name} with ${a.name}.`,
      short: 'Side by side in the shop',
    };
  }
  if (t === 'retail' || t === 'minimart') {
    return {
      title: `Put ${b.name} next to ${a.name}`,
      action: `Place them on the same shelf or near the till, keep both in stock together, and remind cashiers to offer ${b.name} with ${a.name}.`,
      short: 'Same shelf or near the till',
    };
  }
  return {
    title: `Offer ${b.name} with ${a.name}`,
    action: `Show them together, keep both in stock, and remind cashiers to offer ${b.name} to whoever takes ${a.name}.`,
    short: 'Offer together',
  };
}
