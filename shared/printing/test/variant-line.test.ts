/**
 * variant-line.test — A551: a variant on the item's own line, on the kitchen ticket, the dispatch ticket and the receipt.
 *
 * Owner, 2026-10-21, on paper: "on items with variants assume chicken burger instead of writing `Chicken burger` then
 * `  Chicken burger spicy` why not write `Chicken burger - Spicy` we avoid 2 lines of the same item".
 *
 * The till (escposBridge.printSale) and the web (printRouted) build units with toUnits: a product sold with a variant and
 * no components gets ONE unit of itself carrying the variant options as attributes — which printed as a second row with
 * the product's name again ("Chicken Burger" / "Spicy" on the kitchen ticket, "Chicken Burger (Spicy)" on dispatch,
 * "  Chicken Burger  Spicy" on the receipt). Now the options go on the line's own row, a leading repeat of the product's
 * name stripped: "Chicken Burger - Spicy". A combo's variant (on its first component), a modifier and a split
 * ("1 spicy, 2 normal") print as before.
 *
 * MUTATION-CHECKED (rule 10/23), each red on its own: no fold (variantUnit returns undefined) (2, 3, 4); the repeat not
 * stripped (variantLabel returns the option as it is) (1, 2); the whole-word check dropped (1); the folded unit not
 * counted in "items to cook" (2); the fold on any unit with attributes, not only the product's own (5).
 */
import {
  renderTicket, toPreview, kitchenPreset, dispatchPreset, receiptPreset, nameWithVariant, variantLabel, columnsFor,
  type Document, type OrderLine, type PrintContext,
} from '../src/index';
import { toUnits, stationsForCategory } from '../src/routing';
import { order as sampleOrder, business, KITCHEN, DISPATCH } from './fixture';
import { cart, linesOf, ids, routing, variantCases } from './a551-cases';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const textOf = (doc: Document) => doc.blocks.flatMap(b => (b.kind === 'text' ? [b.text] : []));
const order = { ...sampleOrder, lines: variantCases.lines, total: variantCases.total,
  payments: [{ label: 'CASH', amount: variantCases.total }], changeGiven: 0 };
const rows = (ctx: PrintContext) => textOf(renderTicket(ctx));
const kitchen = (w: 58 | 80) => kitchenPreset(KITCHEN, 'Kitchen', w);
const dispatch = (w: 58 | 80) => dispatchPreset(DISPATCH, 'Dispatch', w);
const receipt = (w: 58 | 80) => receiptPreset('st-till', 'Till', w);

console.log('\n1. The name and its variant: the repeat stripped, an unrelated variant kept');
{
  const eq = (got: string, want: string, label: string) => ok(`${label}: "${got}"`, got === want, `want "${want}"`);
  eq(nameWithVariant('Chicken Burger', ['Chicken Burger Spicy']), 'Chicken Burger - Spicy', 'the repeat stripped');
  eq(nameWithVariant('Chicken Burger', ['chicken burger spicy']), 'Chicken Burger - spicy', 'case-insensitive');
  eq(nameWithVariant('Chicken Burger', ['Chicken Burger - Spicy']), 'Chicken Burger - Spicy', 'a dash after the name');
  eq(nameWithVariant('Chicken Burger', ['Chicken Burger: Spicy']), 'Chicken Burger - Spicy', 'a colon after the name');
  eq(nameWithVariant('Chicken Burger', ['Chicken Burger (Spicy)']), 'Chicken Burger - (Spicy)', 'brackets are not separators');
  eq(nameWithVariant('Chicken Burger', ['Spicy']), 'Chicken Burger - Spicy', 'the variant alone');
  eq(nameWithVariant('Chicken Burger', ['Large']), 'Chicken Burger - Large', 'an unrelated variant');
  eq(nameWithVariant('Chicken Burger', ['Chicken Burgers']), 'Chicken Burger - Chicken Burgers', 'only a whole-word repeat');
  eq(nameWithVariant('Chicken Burger', ['Chicken Burger']), 'Chicken Burger', 'a variant that is only the name adds nothing');
  eq(nameWithVariant('Chicken Burger', ['Large', 'Chicken Burger Spicy']), 'Chicken Burger - Large, Spicy', 'two variant groups');
  eq(nameWithVariant('Chicken Burger', ['Spicy', 'spicy']), 'Chicken Burger - Spicy', 'the same option twice, once');
  eq(nameWithVariant('Chicken Burger ', ['  Chicken Burger   Spicy ']), 'Chicken Burger - Spicy', 'spaces trimmed');
  eq(variantLabel('Chicken Burger', 'Chicken Burger Spicy'), 'Spicy', 'variantLabel');
}

console.log('\n2. The kitchen ticket: one row — "1   CHICKEN BURGER - SPICY" — and no second "Chicken Burger" row');
for (const w of [80, 58] as const) {
  const k = rows({ order, business, station: kitchen(w) });
  const p = toPreview(renderTicket({ order, business, station: kitchen(w) }));
  ok(`${w}: the dish's own row carries the variant, on one row`, k.includes('1   CHICKEN BURGER - SPICY')
    && !k.includes('    SPICY'), k.join(' | '));
  ok(`${w}: the product's name printed once, the variant once`, (p.match(/chicken burger/gi) ?? []).length === 2   // + "GRILLED CHICKEN BURGER"
    && (p.match(/spicy/gi) ?? []).length === 1, p);
  ok(`${w}: "2   BEEF BURGER - LARGE" (an unrelated variant)`, k.includes('2   BEEF BURGER - LARGE'), k.join(' | '));
  ok(`${w}: no component row for the variant's unit (6 spaces in)`, !k.some(t => /^ {6,8}(Chicken|Beef|Grilled|Spicy|Large)/i.test(t)));
  ok(`${w}: the folded unit still counts as an item to cook (3)`, k.some(t => t.trim() === '3 items to cook'));
}

console.log('\n3. The dispatch ticket and the receipt: the same one row; a modifier still a row of its own');
for (const w of [80, 58] as const) {
  const d = rows({ order, business, station: dispatch(w) });
  ok(`${w} dispatch: "1   CHICKEN BURGER - SPICY", no "Chicken Burger (Spicy)"`, d.includes('1   CHICKEN BURGER - SPICY')
    && !d.some(t => /\(.*Spicy\)/i.test(t)), d.join(' | '));
  ok(`${w} dispatch: the modifier "Extra Cheese" under "BEEF BURGER - LARGE"`, d[d.indexOf('2   BEEF BURGER - LARGE') + 1] === '      Extra Cheese', d.join(' | '));
  const r = rows({ order, business, station: receipt(w) });
  const at = r.findIndex(t => t.startsWith('Chicken Burger -'));
  ok(`${w} receipt: the item row names the variant, the qty and amount on it`, at >= 0 && /\s1\s+550\.85$/.test(r[at]), r.join(' | '));
  ok(`${w} receipt: no "  Chicken Burger  Spicy" sub-row`, !r.some(t => /^ {2}Chicken Burger/.test(t)), r.join(' | '));
  ok(`${w} receipt: "Spicy" printed once`, r.join('\n').match(/Spicy/g)?.length === 1);
  const beef = r.findIndex(t => t.startsWith('Beef Burger -'));
  ok(`${w} receipt: "Beef Burger - Large", then the modifier "  Extra Cheese"`, beef >= 0
    && r.slice(beef, beef + 3).some(t => t === '  Extra Cheese'), r.slice(beef, beef + 3).join(' | '));
  if (w === 80) ok('80 receipt: "Chicken Burger - Spicy" on one row', r[at].startsWith('Chicken Burger - Spicy '));
}

console.log('\n4. A long name with its variant wraps under itself; the quantity column is kept (A547)');
for (const w of [80, 58] as const) {
  for (const [label, station] of [['kitchen', kitchen(w)], ['dispatch', dispatch(w)]] as const) {
    const k = rows({ order, business, station });
    const at = k.findIndex(t => t.startsWith('1   GRILLED'));
    const rest: string[] = [];
    for (let i = at + 1; i < k.length && /^ {4}\S/.test(k[i]); i++) rest.push(k[i]);
    const cols = columnsFor(w);
    ok(`${label} ${w}: wraps over ${1 + rest.length} rows, each continuation 4 spaces in, none wider than ${cols}`,
      at >= 0 && rest.length >= 1 && [k[at], ...rest].every(t => t.length <= cols), [k[at], ...rest].join(' | '));
    ok(`${label} ${w}: every word there once, the repeat stripped`,
      [k[at], ...rest].map(t => t.trim()).join(' ').replace(/^1\s+/, '') === 'GRILLED CHICKEN BURGER DOUBLE PATTY - EXTRA HOT PERI PERI',
      [k[at], ...rest].join(' | '));
  }
  const r = rows({ order, business, station: receipt(w) });
  const at = r.findIndex(t => t.startsWith('Grilled Chicken'));
  const name = [r[at], r[at + 1], r[at + 2], r[at + 3]].filter(t => t && !/^-+$/.test(t) && !/^Total/.test(t))
    .map(t => t.replace(/\s+1\s+805\.08$/, '').trim()).join(' ');
  ok(`receipt ${w}: the long name wraps in the name column, the amount on the first row`, at >= 0 && /\s1\s+805\.08$/.test(r[at])
    && name.startsWith('Grilled Chicken Burger Double Patty - Extra Hot Peri Peri'), `${name}`);
}

console.log('\n5. What is not a variant\'s own unit prints as before');
{
  // A combo's variant sits on its first component: "3PC Chicken (all spicy)" under the combo, heading unchanged.
  const combo = { product: { id: 'c', name: '3PC Chicken Combo', category_id: 'cat-burgers' }, quantity: 1, lineTotal: 890,
    selectedVariants: [{ groupName: 'Spice', optionName: 'all spicy' }],
    comboComponents: [{ name: '3PC Chicken', quantity: 1, category_id: 'cat-burgers' }, { name: 'Fries', quantity: 1, category_id: 'cat-burgers' }] };
  const lines = linesOf([combo]);
  const o = { ...order, lines, total: lines[0].lineTotal };
  const k = rows({ order: o, business, station: kitchen(80) });
  ok('a combo: the heading is the combo\'s name, the variant under its first component', k.includes('1   3PC CHICKEN COMBO')
    && k.includes('      3PC Chicken') && k.includes('        all spicy'), k.join(' | '));
  // A unit named like the line but split across portions ("1 spicy, 2 normal") is a component, not a variant.
  const split: OrderLine = { name: '3PC Chicken', quantity: 1, unitPrice: 50000, lineTotal: 50000, stationIds: [KITCHEN],
    units: [{ productId: 'p', name: '3PC Chicken', quantity: 1, portions: 3, priceDelta: 0, chosen: true, stationIds: [KITCHEN],
      attributes: [{ group: 'Spice', option: 'spicy', count: 1, priceDelta: 0 }, { group: 'Spice', option: 'normal', count: 2, priceDelta: 0 }] }] };
  const ks = rows({ order: { ...order, lines: [split], total: 50000 }, business, station: kitchen(80) });
  ok('a split across portions: printed as before (heading, component, "1 spicy, 2 normal")', ks.includes('1   3PC CHICKEN')
    && ks.includes('      3PC Chicken') && ks.includes('        1 spicy, 2 normal'), ks.join(' | '));
  // A unit with a price of its own keeps its row (the receipt prints its amount).
  const priced: OrderLine = { ...split, units: [{ ...split.units[0], portions: 1, priceDelta: 5000, attributes: [{ group: 'Size', option: 'Large', count: 1, priceDelta: 0 }] }] };
  const kp = rows({ order: { ...order, lines: [priced], total: 50000 }, business, station: kitchen(80) });
  ok('a unit with its own price: printed as before', kp.includes('1   3PC CHICKEN') && kp.includes('      3PC Chicken'), kp.join(' | '));
  // The routing is the same: the variant's unit still routes the line (no kitchen for a drink, kitchen for the burger).
  const units = toUnits(cart[0], ids, stationsForCategory('cat-burgers', ids, routing), routing);
  ok('toUnits still gives the product\'s own unit with the variant (the till\'s shape, unchanged)', units.length === 1
    && units[0].name === 'Chicken Burger' && units[0].attributes[0].option === 'Chicken Burger Spicy' && units[0].stationIds.includes(KITCHEN));
}

console.log('\n7. A556 — the receipt folds EVERY variant: a combo and a product with a description (the owner\'s paper test)');
{
  const ids2 = { kitchen: [KITCHEN], dispatch: [DISPATCH] };
  const r2 = { byCategory: {}, kitchenCategories: new Set<string>() };
  const mk = (l: any, cents: number): OrderLine => ({ name: l.product.name, quantity: 1, stationIds: [KITCHEN], unitPrice: cents,
    lineTotal: cents, units: toUnits(l, ids2, ids2.kitchen, r2) });
  const described = mk({ product: { id: 'a', name: 'Crispy Chicken Burger', description: 'Crispy fillet, lettuce, house sauce' },
    selectedVariants: [{ groupName: 'Spice level', optionName: 'Spicy' }] }, 55000);
  const combo = mk({ product: { id: 'c', name: '5PC Chicken Combo' }, comboComponents: [{ name: '5PC Chicken', quantity: 1, is_kitchen: true },
    { name: 'Fries', quantity: 1, is_kitchen: true }], selectedVariants: [{ groupName: 'Spice level', optionName: 'Normal' }] }, 139000);
  const priced: OrderLine = { ...combo, units: combo.units.map((u, i) => (i === 0 ? { ...u, priceDelta: 5000 } : u)), lineTotal: 144000, unitPrice: 144000 };
  for (const w of [80, 58] as const) {
    const o = { ...order, lines: [described, combo], total: 194000, payments: [{ label: 'CASH', amount: 194000 }] };
    const rr = rows({ order: o, business, station: receipt(w) });
    // On 58 mm the item column is narrower, so a long "name - variant" wraps like any long name ("Crispy Chicken" /
    // "Burger - Spicy"); what matters is that it is the ITEM's text, and no sub-row repeats the item with the choice.
    const item = rr.slice(rr.findIndex(t => t.startsWith('Item')) + 2, rr.findIndex(t => t.startsWith('Total Qty')) - 1)
      .map(t => t.replace(/\s+\d+\s+[\d,]+\.\d\d$/, '').trim()).join(' ');
    ok(`${w} mm receipt: "Crispy Chicken Burger - Spicy" is the item, no "Crispy fillet  Spicy" row`,
      item.includes('Crispy Chicken Burger - Spicy') && !rr.some(t => /Crispy fillet/.test(t)), item);
    ok(`${w} mm receipt: "5PC Chicken Combo - Normal" is the item, no "5PC Chicken  Normal" row`,
      item.includes('5PC Chicken Combo - Normal') && !rr.some(t => /^\s+5PC Chicken/.test(t)), item);
  }
  const pr = rows({ order: { ...order, lines: [priced], total: 144000, payments: [{ label: 'CASH', amount: 144000 }] }, business, station: receipt(80) });
  ok('a priced component keeps its own price row, its choice moved to the heading', pr.some(t => t.startsWith('5PC Chicken Combo - Normal'))
    && pr.some(t => /^\s+5PC Chicken\s+\S/.test(t) && !/Normal/.test(t)), pr.join(' | '));
  const k = rows({ order: { ...order, lines: [described, combo], total: 194000 }, business, station: kitchen(80) });
  ok('kitchen: the described burger folds — "1   CRISPY CHICKEN BURGER - SPICY", its parts listed beneath without the choice',
    k.includes('1   CRISPY CHICKEN BURGER - SPICY') && k.some(t => t.trim() === 'Crispy fillet'), k.join(' | '));
  ok('kitchen: a combo keeps the choice on its component (the cook sees which piece)',
    k.includes('1   5PC CHICKEN COMBO') && k.some(t => /5PC Chicken/.test(t) && !/COMBO/.test(t)) && k.some(t => /Normal/.test(t)), k.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
