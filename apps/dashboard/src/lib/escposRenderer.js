// scripts/escpos-renderer/buffer-shim.js
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = { from: (a) => Uint8Array.from(a) };
}

// shared/printing/src/document.ts
var DocBuilder = class {
  constructor(columns) {
    this.columns = columns;
    this.blocks = [];
  }
  /** Pre-formatted lines from layout.ts go through here unchanged. */
  line(text, opts = {}) {
    this.blocks.push({
      kind: "text",
      text,
      align: opts.align ?? "left",
      size: opts.size ?? "normal",
      bold: opts.bold ?? false
    });
    return this;
  }
  lines(texts, opts = {}) {
    for (const t of texts) this.line(t, opts);
    return this;
  }
  blank(n = 1) {
    for (let i = 0; i < n; i++) this.line("");
    return this;
  }
  feed(lines) {
    this.blocks.push({ kind: "feed", lines });
    return this;
  }
  cut() {
    this.blocks.push({ kind: "cut" });
    return this;
  }
  drawer() {
    this.blocks.push({ kind: "drawer" });
    return this;
  }
  /** Blocks emitted so far. Lets a caller tell whether a section printed
   *  anything without inspecting the blocks themselves. */
  get length() {
    return this.blocks.length;
  }
  build() {
    return { columns: this.columns, blocks: this.blocks };
  }
};

// shared/printing/src/money.ts
var MICROS = 1e6;
var MAX_SAFE_CENTS = 9e9;
function grossToNetMicros(gross, vatRate, ctlRate) {
  const rateBps = Math.round((vatRate + ctlRate) * 100);
  return Math.round(gross * MICROS * 1e4 / (1e4 + rateBps));
}
function microsToCents(m) {
  return Math.round(m / MICROS);
}
function splitTax(lineGrosses, total, vatRate, ctlRate) {
  if (!Number.isInteger(total)) {
    throw new Error(`total must be integer cents, got ${total}`);
  }
  if (Math.abs(total) > MAX_SAFE_CENTS) {
    throw new Error(`total ${total} exceeds the safe integer range for micro-cent arithmetic`);
  }
  const summed = lineGrosses.reduce((a, b) => a + b, 0);
  if (summed !== total) {
    throw new Error(`line grosses sum to ${summed} but order total is ${total}`);
  }
  const netMicrosPerLine = lineGrosses.map((g) => grossToNetMicros(g, vatRate, ctlRate));
  const netMicrosTotal = netMicrosPerLine.reduce((a, b) => a + b, 0);
  const subtotal = microsToCents(netMicrosTotal);
  const ctl = microsToCents(Math.round(netMicrosTotal * Math.round(ctlRate * 100) / 1e4));
  const vat = microsToCents(Math.round(netMicrosTotal * Math.round(vatRate * 100) / 1e4));
  return {
    subtotal,
    ctl,
    vat,
    roundOff: total - (subtotal + ctl + vat),
    total,
    lineNets: netMicrosPerLine.map(microsToCents)
  };
}
function netOf(gross, vatRate, ctlRate) {
  return microsToCents(grossToNetMicros(gross, vatRate, ctlRate));
}
function formatCents(c) {
  const neg = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${grouped}.${String(frac).padStart(2, "0")}`;
}

// shared/printing/src/layout.ts
function columnsFor(paperWidthMm) {
  return paperWidthMm === 80 ? 48 : 32;
}
function sanitize(s) {
  return s.replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/[\u00A0\u2007\u202F]/g, " ").replace(/[^\x20-\x7E]/g, "");
}
function center(cols, text) {
  const t = sanitize(text).slice(0, cols);
  const pad = Math.max(0, Math.floor((cols - t.length) / 2));
  return " ".repeat(pad) + t;
}
function rule(cols, ch = "-") {
  return ch.repeat(cols);
}
function pair(cols, left, right) {
  const l = sanitize(left);
  const r = sanitize(right);
  const gap = cols - l.length - r.length;
  if (gap < 1) {
    const keep = Math.max(0, cols - r.length - 1);
    return l.slice(0, keep) + " " + r;
  }
  return l + " ".repeat(gap) + r;
}
function pairOrStack(cols, left, right) {
  const l = sanitize(left);
  const r = sanitize(right);
  if (l.length + r.length + 1 <= cols) return [pair(cols, l, r)];
  return [l.slice(0, cols), " ".repeat(Math.max(0, cols - r.length)) + r.slice(0, cols)];
}
function hangingWrap(text, width, indent) {
  const segs = wrap(text, width);
  return segs.map((s, i) => i === 0 ? s : " ".repeat(indent) + s);
}
function itemColumns(cols) {
  const amt = cols >= 48 ? 12 : 10;
  const qty = cols >= 48 ? 5 : 4;
  return { name: cols - amt - qty, qty, amt };
}
function itemRow(cols, name, qty, amt) {
  const c = itemColumns(cols);
  const segments = wrap(sanitize(name), c.name - 1);
  return segments.map((seg, i) => {
    const namePart = seg.padEnd(c.name, " ");
    if (i > 0) return namePart.trimEnd();
    return namePart + qty.padStart(c.qty, " ") + amt.padStart(c.amt, " ");
  });
}
function subRow(cols, text, amt, indent = 2) {
  const body = " ".repeat(indent) + sanitize(text);
  if (!amt) return wrap(body, cols).map((l, i) => i === 0 ? l : " ".repeat(indent) + l.trimStart());
  const amtW = itemColumns(cols).amt;
  const avail = cols - amtW;
  if (body.length <= avail) return [body.padEnd(avail, " ") + amt.padStart(amtW, " ")];
  const wrapped = wrap(body, cols);
  return [...wrapped, "".padEnd(avail, " ") + amt.padStart(amtW, " ")];
}
function wrapAuthored(text, width) {
  return text.split(/\r?\n/).flatMap((line) => line.trim() ? wrap(line.trim(), width) : [""]);
}
function wrap(text, width) {
  const t = sanitize(text);
  if (width <= 0) return [t];
  if (t.length <= width) return [t];
  const out = [];
  let line = "";
  for (const word of t.split(/\s+/)) {
    if (!line.length) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      out.push(line);
      line = word;
    }
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line.length) out.push(line);
  return out;
}

// shared/printing/src/render.ts
var TYPE_CAPS = {
  takeaway: "TAKEAWAY",
  dine_in: "DINE IN",
  delivery: "DELIVERY",
  counter: "COUNTER"
};
var TYPE_TITLE = {
  takeaway: "Takeaway",
  dine_in: "Dine In",
  delivery: "Delivery",
  counter: "Counter"
};
var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var p2 = (n) => String(n).padStart(2, "0");
function shortStamp(d) {
  return `${DAYS[d.getDay()]} ${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function fullStamp(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function rate(n) {
  return String(Number(n.toFixed(2)));
}
function describeAttributes(unit) {
  if (!unit.attributes.length) return "";
  const total = unit.attributes.reduce((a, x) => a + x.count, 0);
  if (unit.attributes.length === 1) {
    const only = unit.attributes[0];
    const whole = only.count >= unit.portions && unit.portions > 1;
    return whole ? `all ${only.option}` : only.option;
  }
  return unit.attributes.filter((a) => a.count > 0).map((a) => total === unit.portions ? `${a.count} ${a.option}` : `${a.count} x ${a.option}`).join(", ");
}
function visibleUnits(line, ctx) {
  const { station } = ctx;
  if (station.includeUnits === "none") return [];
  let units = line.units;
  if (station.includeUnits === "routed") {
    units = units.filter((u) => u.stationIds.includes(station.id));
  }
  if (!station.showUnchangedUnits) {
    units = units.filter((u) => u.chosen || u.priceDelta !== 0 || u.attributes.length > 0);
  }
  return units;
}
function renderProduction(ctx) {
  const { order, station } = ctx;
  const cols = columnsFor(station.paperWidthMm);
  const d = new DocBuilder(cols);
  if (ctx.voided) {
    d.line("VOID", { align: "center", size: "large", bold: true });
    d.line(rule(cols));
  }
  d.line(`* * ${station.name.toUpperCase()} * *`, { align: "center", size: "tall", bold: true });
  d.blank();
  d.lines(pairOrStack(cols, `Order  ${order.billNumber}`, TYPE_CAPS[order.orderType]));
  d.lines(pairOrStack(cols, shortStamp(order.soldAt), `Cashier  ${order.cashierName}`));
  if (order.orderType === "dine_in" && order.tableNumber) {
    d.line(`Table  ${order.tableNumber}`);
  }
  if (order.orderType === "delivery" && order.deliveryPerson) {
    d.line(`Rider  ${order.deliveryPerson}`);
  }
  if (ctx.reprint) {
    d.line(`REPRINT  ${fullStamp(ctx.reprint.at)}  (#${ctx.reprint.count})`);
  }
  d.line(rule(cols));
  let unitRows = 0;
  let printedLines = 0;
  for (const line of order.lines) {
    const units = visibleUnits(line, ctx);
    if (station.includeUnits !== "none") {
      const earns = line.units.length > 0 ? units.length > 0 : station.includeUnits === "all" || line.stationIds.includes(station.id);
      if (!earns) continue;
    }
    if (printedLines > 0) d.blank();
    printedLines++;
    const qtyPrefix = `${line.quantity}   `;
    const headingWidth = station.emphasizeParent ? Math.floor(cols / 2) : cols;
    d.lines(
      hangingWrap(`${qtyPrefix}${line.name.toUpperCase()}`, headingWidth, qtyPrefix.length),
      { size: station.emphasizeParent ? "tall" : "normal", bold: true }
    );
    if (line.units.length === 0) {
      unitRows++;
      continue;
    }
    for (const u of units) {
      unitRows++;
      const attrs = describeAttributes(u);
      const qty = u.quantity > 1 ? ` x${u.quantity}` : "";
      const inline = station.attributeStyle === "inline-when-simple" && attrs ? ` (${attrs})` : "";
      d.lines(subRow(cols, `${u.name}${qty}${inline}`, void 0, 6));
      if (attrs && !inline) {
        d.lines(subRow(cols, attrs, void 0, 8));
      }
    }
    if (line.note) {
      d.lines(subRow(cols, `** ${line.note}`, void 0, 6));
    }
  }
  d.line(rule(cols));
  if (station.showFooterCount) {
    const label = station.kind === "kitchen" ? `${unitRows} items to cook` : `${printedLines} bags`;
    d.line(center(cols, label));
  }
  return d.build();
}
function renderReceipt(ctx) {
  const { order, business, station } = ctx;
  const cols = columnsFor(station.paperWidthMm);
  const c = itemColumns(cols);
  const d = new DocBuilder(cols);
  if (ctx.voided) {
    d.line("VOID", { align: "center", size: "large", bold: true });
    d.line(rule(cols));
  }
  if (ctx.reprint) {
    d.line("Duplicate Print", { align: "center", size: "tall", bold: true });
    d.line(rule(cols));
  }
  d.line(center(cols, business.name), { bold: true });
  if (business.branchName) d.line(center(cols, business.branchName));
  if (business.header) {
    for (const ln of business.header.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      d.line(center(cols, ln));
    }
  }
  if (business.kraPin) d.line(center(cols, `PIN: ${business.kraPin}`));
  if (business.telephone) d.line(center(cols, `Tel: ${business.telephone}`));
  d.line(rule(cols));
  d.line(`Type: ${TYPE_TITLE[order.orderType]}`);
  d.line(rule(cols));
  d.line(`Bill No.: ${order.billNumber}`);
  if (order.orderType === "delivery") d.line(`Delivery Boy: ${order.deliveryPerson ?? ""}`);
  if (order.orderType === "dine_in" && order.tableNumber) d.line(`Table: ${order.tableNumber}`);
  d.line(`Cashier: ${order.cashierName}`);
  d.line(`Date: ${fullStamp(order.soldAt)}`);
  if (ctx.reprint) d.line(`RePrint T.: ${fullStamp(ctx.reprint.at)}`);
  if (ctx.voided) d.line(`Voided: ${fullStamp(ctx.voided.at)} by ${ctx.voided.by}`);
  d.line(`Kots: ${order.kotCount}`);
  d.line(rule(cols));
  d.line("Item".padEnd(c.name) + "Qty".padStart(c.qty) + "Amt".padStart(c.amt));
  d.line(rule(cols));
  const tax = splitTax(
    order.lines.map((l) => l.lineTotal),
    order.total,
    business.vatRate,
    business.ctlRate
  );
  let totalQty = 0;
  let lastHadSubLines = false;
  order.lines.forEach((line, i) => {
    totalQty += line.quantity;
    if (lastHadSubLines) d.blank();
    const deltas = line.units.reduce((a, u) => a + u.priceDelta * u.quantity, 0);
    const baseNet = tax.lineNets[i] - netOf(deltas * line.quantity, business.vatRate, business.ctlRate);
    d.lines(itemRow(cols, line.name, String(line.quantity), formatCents(baseNet)));
    const units = visibleUnits(line, ctx);
    const before = d.length;
    const plain = [];
    for (const u of units) {
      const attrs = describeAttributes(u);
      const delta = u.priceDelta * u.quantity;
      if (!attrs && delta === 0) {
        plain.push(u.name);
        continue;
      }
      if (attrs) {
        d.lines(subRow(cols, `${u.name}  ${attrs}`, void 0, 2));
      }
      if (delta !== 0 && station.showOptionPrices) {
        const net = netOf(delta * line.quantity, business.vatRate, business.ctlRate);
        d.lines(subRow(cols, u.name, formatCents(net), 2));
      } else if (delta !== 0) {
        d.lines(subRow(cols, u.name, void 0, 2));
      }
    }
    if (plain.length) d.lines(subRow(cols, plain.join(", "), void 0, 2));
    if (line.note) d.lines(subRow(cols, `** ${line.note}`, void 0, 2));
    lastHadSubLines = d.length > before;
  });
  d.line(rule(cols));
  d.line(pair(cols, "Total Qty:", String(totalQty)));
  d.line(pair(cols, "SubTotal:", formatCents(tax.subtotal)));
  d.line(rule(cols));
  d.line(pair(cols, `CTL (${rate(business.ctlRate)}%)`, formatCents(tax.ctl)));
  d.line(pair(cols, `VAT (${rate(business.vatRate)}%)`, formatCents(tax.vat)));
  d.line(rule(cols));
  d.line(pair(cols, "Round Off:", formatCents(tax.roundOff)));
  d.line(pair(cols, "Total:", formatCents(tax.total)), { bold: true });
  d.line(rule(cols));
  d.line(`PAY: ${business.currencyCode} ${formatCents(tax.total)}`, { size: "tall", bold: true });
  d.line(rule(cols));
  d.line("Payment Detail:", { bold: true });
  d.line(rule(cols));
  for (const leg of order.payments) {
    d.line(pair(cols, leg.label.toUpperCase(), formatCents(leg.amount)));
  }
  if (order.changeGiven > 0) {
    d.line(pair(cols, "CHANGE", formatCents(order.changeGiven)));
  }
  d.line(rule(cols));
  if (business.tillNumber) {
    d.line(`${business.tillLabel ?? "Buy Goods"}: ${business.tillNumber}`);
    d.line(rule(cols));
  }
  if (business.thankYouMessage) {
    d.lines(wrapAuthored(business.thankYouMessage, cols).map((l) => center(cols, l)));
  }
  if (business.deliveryMessage) {
    d.lines(wrapAuthored(business.deliveryMessage, cols).map((l) => center(cols, l)));
  }
  if (business.thankYouMessage || business.deliveryMessage) d.line(rule(cols));
  d.lines(wrap(business.closingMessage ?? "Thank you for your business!", cols).map((l) => center(cols, l)));
  if (business.vatRate > 0) {
    d.line(center(cols, "TAX RECEIPT UPON REQUEST"));
  }
  if (business.footerCredit) d.line(center(cols, business.footerCredit));
  return d.build();
}
function renderTicket(ctx) {
  return ctx.station.kind === "receipt" ? renderReceipt(ctx) : renderProduction(ctx);
}

// shared/printing/src/escpos.ts
var ESC = 27;
var GS = 29;
var INIT = [ESC, 64];
var CODEPAGE_CP437 = [ESC, 116, 0];
var LINE_SPACING_DEFAULT = [ESC, 50];
var ALIGN = { left: 0, center: 1, right: 2 };
function sizeByte(size) {
  switch (size) {
    case "normal":
      return 0;
    case "tall":
      return 1;
    case "wide":
      return 16;
    case "large":
      return 17;
  }
}
function toEscPos(doc, opts = {}) {
  const out = [];
  const push = (...bytes) => out.push(...bytes);
  const text = (s) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out.push(c > 126 || c < 32 ? 63 : c);
    }
  };
  push(...INIT, ...CODEPAGE_CP437, ...LINE_SPACING_DEFAULT);
  let curAlign = -1;
  let curSize = -1;
  let curBold = -1;
  for (const block of doc.blocks) {
    switch (block.kind) {
      case "text": {
        const b = block;
        const a = ALIGN[b.align];
        if (a !== curAlign) {
          push(ESC, 97, a);
          curAlign = a;
        }
        const s = sizeByte(b.size);
        if (s !== curSize) {
          push(GS, 33, s);
          curSize = s;
        }
        const bold = b.bold ? 1 : 0;
        if (bold !== curBold) {
          push(ESC, 69, bold);
          curBold = bold;
        }
        text(b.text);
        push(10);
        break;
      }
      case "feed":
        push(ESC, 100, Math.max(0, Math.min(255, block.lines)));
        break;
      case "drawer":
        push(ESC, 112, 0, 25, 250);
        break;
      case "cut":
        push(GS, 86, 66, 0);
        break;
    }
  }
  push(ESC, 97, 0, GS, 33, 0, ESC, 69, 0);
  if (opts.openDrawer) push(ESC, 112, 0, 25, 250);
  if (opts.feedBeforeCut) push(ESC, 100, opts.feedBeforeCut);
  if (opts.cut) push(GS, 86, 66, 0);
  return Buffer.from(out);
}

// shared/printing/src/routing.ts
var toCents = (v) => Math.round((Number(v) || 0) * 100);
function idsByKind(stations) {
  return {
    kitchen: stations.filter((s) => s.kind === "kitchen").map((s) => s.id),
    dispatch: stations.filter((s) => s.kind === "dispatch").map((s) => s.id)
  };
}
function stationsForCategory(categoryId, ids, routing) {
  const all = [...ids.kitchen, ...ids.dispatch];
  if (!categoryId) return ids.dispatch;
  const configured = (routing.byCategory[categoryId] ?? []).filter((id) => all.includes(id));
  if (configured.length) return configured;
  return routing.kitchenCategories.has(categoryId) ? ids.kitchen : ids.dispatch;
}
function describeFromText(text) {
  if (!text) return [];
  const raw = text.trim();
  if (!raw || raw.length > 200) return [];
  const SEPARATORS = [/\r?\n/, /\s*[•·]\s*/, /\s+\+\s+/, /\s*,\s*/, /\s*\/\s*/];
  for (const sep of SEPARATORS) {
    const parts = raw.split(sep).map((t) => t.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    if (parts.length > 12) continue;
    const looksLikeItems = parts.every((t) => t.length <= 40 && t.split(/\s+/).length <= 6 && !/[.;:!?]$/.test(t));
    if (!looksLikeItems) continue;
    return parts;
  }
  return [];
}
function isExcludedFromKitchen(name, exclusions) {
  if (!name) return false;
  const hay = name.toLowerCase();
  return exclusions.some((term) => {
    const t = term.trim().toLowerCase();
    if (!t) return false;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(hay);
  });
}
function toUnits(line, ids, lineStationIds, routing) {
  const lineProductId = line.product.id;
  const lineName = line.product.name;
  const units = [];
  for (const c of line.comboComponents ?? []) {
    units.push({
      productId: c.name,
      name: c.name,
      quantity: c.quantity,
      portions: 1,
      priceDelta: 0,
      chosen: false,
      attributes: [],
      stationIds: c.category_id ? stationsForCategory(c.category_id, ids, routing) : c.is_kitchen ? ids.kitchen : ids.dispatch
    });
  }
  if (units.length === 0) {
    for (const part of describeFromText(line.product.description)) {
      units.push({
        productId: part,
        name: part,
        quantity: 1,
        portions: 1,
        priceDelta: 0,
        chosen: false,
        attributes: [],
        stationIds: lineStationIds
      });
    }
  }
  const attrs = (line.selectedVariants ?? []).filter((v) => v.optionName).map((v) => ({
    group: v.groupName ?? "",
    option: v.optionName,
    count: 1,
    priceDelta: 0
  }));
  if (attrs.length) {
    if (units.length) {
      units[0].attributes = attrs;
      units[0].chosen = true;
    } else {
      units.push({
        productId: lineProductId,
        name: lineName,
        quantity: 1,
        portions: 1,
        priceDelta: 0,
        chosen: true,
        attributes: attrs,
        stationIds: lineStationIds
      });
    }
  }
  for (const m of line.selectedModifiers ?? []) {
    if (!m.name) continue;
    units.push({
      productId: m.name,
      name: m.name,
      quantity: 1,
      portions: 1,
      priceDelta: toCents(m.price ?? 0),
      chosen: true,
      attributes: [],
      stationIds: ids.dispatch
    });
  }
  return units;
}

// scripts/escpos-renderer/entry.ts
var receiptStation = (paperWidthMm) => ({
  id: "web-receipt",
  name: "Receipt",
  kind: "receipt",
  paperWidthMm,
  // Web adaptation: the flat web cart has no combo base/delta split, so we show
  // variant/modifier sub-items as NAMES (showUnchangedUnits) and DON'T print
  // per-upgrade prices (the line's Amt is the true lineTotal — totals stay exact).
  includeUnits: "all",
  showPrices: true,
  showUnchangedUnits: true,
  showOptionPrices: false,
  emphasizeParent: false,
  aggregateUnits: false,
  showFooterCount: false,
  attributeStyle: "inline-when-simple",
  openCashDrawer: true,
  cutPaper: true,
  feedBeforeCut: 3
});
var kitchenStation = (paperWidthMm) => ({
  id: "web-kitchen",
  name: "Kitchen",
  kind: "kitchen",
  paperWidthMm,
  includeUnits: "all",
  showPrices: false,
  showUnchangedUnits: true,
  showOptionPrices: false,
  emphasizeParent: true,
  aggregateUnits: false,
  showFooterCount: true,
  attributeStyle: "always-sublines",
  openCashDrawer: false,
  cutPaper: true,
  feedBeforeCut: 3
});
var dispatchStation = (paperWidthMm) => ({
  id: "web-dispatch",
  name: "Dispatch",
  kind: "dispatch",
  paperWidthMm,
  includeUnits: "all",
  showPrices: false,
  showUnchangedUnits: true,
  showOptionPrices: false,
  emphasizeParent: false,
  aggregateUnits: false,
  showFooterCount: true,
  attributeStyle: "inline-when-simple",
  openCashDrawer: false,
  cutPaper: true,
  feedBeforeCut: 3
});
var withDate = (order) => ({ ...order, soldAt: order.soldAt ? new Date(order.soldAt) : /* @__PURE__ */ new Date() });
function renderReceiptEscPos(order, business, paperWidth) {
  return toEscPos(renderTicket({ order: withDate(order), business, station: receiptStation(paperWidth) }));
}
function renderKitchenEscPos(order, business, paperWidth) {
  return toEscPos(renderTicket({ order: withDate(order), business, station: kitchenStation(paperWidth) }));
}
function renderDispatchEscPos(order, business, paperWidth) {
  return toEscPos(renderTicket({ order: withDate(order), business, station: dispatchStation(paperWidth) }));
}
function stationConfig(station) {
  const common = { id: station.id, paperWidthMm: station.paperWidthMm, aggregateUnits: false, feedBeforeCut: 3, cutPaper: true };
  if (station.kind === "receipt")
    return {
      ...common,
      name: "Receipt",
      kind: "receipt",
      includeUnits: "all",
      showPrices: true,
      showUnchangedUnits: true,
      showOptionPrices: false,
      emphasizeParent: false,
      showFooterCount: false,
      attributeStyle: "inline-when-simple",
      openCashDrawer: true
    };
  if (station.kind === "kitchen")
    return {
      ...common,
      name: "Kitchen",
      kind: "kitchen",
      includeUnits: "routed",
      showPrices: false,
      showUnchangedUnits: true,
      showOptionPrices: false,
      emphasizeParent: true,
      showFooterCount: true,
      attributeStyle: "always-sublines",
      openCashDrawer: false
    };
  return {
    ...common,
    name: "Dispatch",
    kind: "dispatch",
    includeUnits: "all",
    showPrices: false,
    showUnchangedUnits: true,
    showOptionPrices: false,
    emphasizeParent: false,
    showFooterCount: true,
    attributeStyle: "inline-when-simple",
    openCashDrawer: false
  };
}
function renderStationEscPos(order, business, station) {
  return toEscPos(renderTicket({ order: withDate(order), business, station: stationConfig(station) }));
}
var renderEscPos = renderReceiptEscPos;
export {
  idsByKind,
  isExcludedFromKitchen,
  renderDispatchEscPos,
  renderEscPos,
  renderKitchenEscPos,
  renderReceiptEscPos,
  renderStationEscPos,
  stationsForCategory,
  toUnits
};
