#!/usr/bin/env python3
"""
importer — turns a filled-in composition workbook into menu rows.

THE POINT OF THIS FILE is not to import Kudo Kudo. It is to demonstrate that one
importer, with no knowledge of any specific menu, loads three businesses that
share nothing:

  - a fried-chicken shop with combos, upgrades and a spice attribute
  - a coffee shop with size and milk choices and no combos at all
  - a butchery that sells by named cut with no attributes and no slots

If all three load into the same tables and the same validation passes for each,
the schema is adaptive in the way the POS requires. If the coffee shop needed a
column the chicken shop did not, it would not be.

The tables here are a SQLite mirror of migration.sql — same names, same shape —
so the importer logic is exercised for real rather than described. The
production importer swaps this connection for Supabase and the SQL is identical.
"""

import sqlite3
import sys
from dataclasses import dataclass, field

SCHEMA = """
CREATE TABLE products (
  id INTEGER PRIMARY KEY, business_id TEXT, name TEXT, category TEXT,
  price_cents INTEGER, menu_visible INTEGER DEFAULT 1, portions INTEGER DEFAULT 1
);
CREATE TABLE component_slots (
  id INTEGER PRIMARY KEY, business_id TEXT, product_id INTEGER, name TEXT,
  sort_order INTEGER, min_select INTEGER, max_select INTEGER
);
CREATE TABLE slot_options (
  id INTEGER PRIMARY KEY, slot_id INTEGER, option_product_id INTEGER,
  quantity INTEGER, price_delta_cents INTEGER, is_default INTEGER, sort_order INTEGER
);
CREATE TABLE attribute_groups (
  id INTEGER PRIMARY KEY, business_id TEXT, name TEXT, min_select INTEGER, max_select INTEGER
);
CREATE TABLE attribute_options (
  id INTEGER PRIMARY KEY, group_id INTEGER, name TEXT, price_delta_cents INTEGER, sort_order INTEGER
);
CREATE TABLE product_attributes (product_id INTEGER, group_id INTEGER);
CREATE TABLE category_stations (business_id TEXT, category TEXT, station TEXT);
"""


@dataclass
class Product:
    name: str
    category: str
    price_cents: int | None = None       # None = never sold alone
    portions: int = 1


@dataclass
class Slot:
    product: str
    name: str
    min_select: int = 1
    max_select: int = 1
    options: list = field(default_factory=list)   # (option_product, qty, delta, default)


@dataclass
class AttrGroup:
    name: str
    options: list                                  # (name, delta)
    attaches_to: list                              # product names
    min_select: int = 1
    max_select: int = 1


@dataclass
class Menu:
    business_id: str
    products: list
    slots: list = field(default_factory=list)
    attributes: list = field(default_factory=list)
    routing: list = field(default_factory=list)    # (category, station)


class ImportError_(Exception):
    pass


def load(conn: sqlite3.Connection, menu: Menu) -> None:
    """The whole importer. Menu-agnostic: it reads the five idea-types and
    writes rows. It never checks for a category, an item, or an attribute by
    name — it cannot, because it does not know what business it is loading."""
    cur = conn.cursor()
    pid = {}

    # Products. A missing price means never-sold-alone, which is menu_visible=0.
    for p in menu.products:
        visible = 0 if p.price_cents is None else 1
        cur.execute(
            "INSERT INTO products (business_id,name,category,price_cents,menu_visible,portions)"
            " VALUES (?,?,?,?,?,?)",
            (menu.business_id, p.name, p.category, p.price_cents, visible, p.portions),
        )
        pid[p.name] = cur.lastrowid

    # Slots and their options. Every option must resolve to a real product, or
    # the menu is internally inconsistent and the import is rejected — a slot
    # pointing at a nonexistent product is exactly the kind of typo the old
    # prose descriptions hid.
    for order, s in enumerate(menu.slots):
        if s.product not in pid:
            raise ImportError_(f"slot '{s.name}' is on unknown product '{s.product}'")
        cur.execute(
            "INSERT INTO component_slots (business_id,product_id,name,sort_order,min_select,max_select)"
            " VALUES (?,?,?,?,?,?)",
            (menu.business_id, pid[s.product], s.name, order, s.min_select, s.max_select),
        )
        slot_id = cur.lastrowid
        defaults = 0
        for oorder, (opt, qty, delta, default) in enumerate(s.options):
            if opt not in pid:
                raise ImportError_(f"slot '{s.name}' offers unknown product '{opt}'")
            defaults += 1 if default else 0
            cur.execute(
                "INSERT INTO slot_options (slot_id,option_product_id,quantity,price_delta_cents,is_default,sort_order)"
                " VALUES (?,?,?,?,?,?)",
                (slot_id, pid[opt], qty, delta, 1 if default else 0, oorder),
            )
        # A single-select slot needs exactly one default; a multi-select needs
        # its min met by defaults so an untouched combo is already valid.
        if s.max_select == 1 and defaults != 1:
            raise ImportError_(f"slot '{s.name}' must have exactly one default, has {defaults}")
        if defaults < s.min_select:
            raise ImportError_(f"slot '{s.name}' has {defaults} defaults but requires {s.min_select}")

    # Attributes, attached to products by name.
    for a in menu.attributes:
        cur.execute(
            "INSERT INTO attribute_groups (business_id,name,min_select,max_select) VALUES (?,?,?,?)",
            (menu.business_id, a.name, a.min_select, a.max_select),
        )
        gid = cur.lastrowid
        for o_order, (oname, delta) in enumerate(a.options):
            cur.execute(
                "INSERT INTO attribute_options (group_id,name,price_delta_cents,sort_order) VALUES (?,?,?,?)",
                (gid, oname, delta, o_order),
            )
        for prod in a.attaches_to:
            if prod not in pid:
                raise ImportError_(f"attribute '{a.name}' attaches to unknown product '{prod}'")
            cur.execute("INSERT INTO product_attributes (product_id,group_id) VALUES (?,?)",
                        (pid[prod], gid))

    for category, station in menu.routing:
        cur.execute("INSERT INTO category_stations (business_id,category,station) VALUES (?,?,?)",
                    (menu.business_id, category, station))

    conn.commit()


def price(cents: int) -> str:
    return f"{cents // 100}.{cents % 100:02d}"


def summarize(conn: sqlite3.Connection, business_id: str) -> None:
    """Reconstructs one composite product from the loaded rows, to show the data
    round-trips. Menu-agnostic: it asks the tables what has slots, it does not
    know what a combo is."""
    cur = conn.cursor()
    prods = cur.execute("SELECT COUNT(*) FROM products WHERE business_id=?", (business_id,)).fetchone()[0]
    hidden = cur.execute("SELECT COUNT(*) FROM products WHERE business_id=? AND menu_visible=0", (business_id,)).fetchone()[0]
    slots = cur.execute(
        "SELECT COUNT(*) FROM component_slots WHERE business_id=?", (business_id,)).fetchone()[0]
    attrs = cur.execute("SELECT COUNT(*) FROM attribute_groups WHERE business_id=?", (business_id,)).fetchone()[0]

    print(f"  {prods} products ({hidden} hidden components), {slots} slots, {attrs} attribute groups")

    # Pick the product with the most slots and print how it resolves.
    row = cur.execute("""
        SELECT p.id, p.name, p.price_cents, COUNT(s.id) n
        FROM products p JOIN component_slots s ON s.product_id = p.id
        WHERE p.business_id = ?
        GROUP BY p.id ORDER BY n DESC LIMIT 1
    """, (business_id,)).fetchone()
    if not row:
        print("  (no composite products — a flat menu, which is fine)")
        return

    pid_, name, pcents, _ = row
    print(f"  e.g. {name} @ {price(pcents)}:")
    for slot_id, sname, mn, mx in cur.execute(
        "SELECT id,name,min_select,max_select FROM component_slots WHERE product_id=? ORDER BY sort_order",
        (pid_,),
    ).fetchall():
        opts = cur.execute("""
            SELECT pr.name, o.price_delta_cents, o.is_default, o.quantity
            FROM slot_options o JOIN products pr ON pr.id = o.option_product_id
            WHERE o.slot_id=? ORDER BY o.sort_order
        """, (slot_id,)).fetchall()
        pick = "pick %d" % mn if mn == mx else "pick %d-%d" % (mn, mx)
        shown = []
        for oname, delta, isdef, qty in opts[:4]:
            tag = "*" if isdef else ""
            d = f" +{price(delta)}" if delta else ""
            q = f"{qty}x " if qty > 1 else ""
            shown.append(f"{tag}{q}{oname}{d}")
        more = f" +{len(opts)-4} more" if len(opts) > 4 else ""
        print(f"     {sname} ({pick}): {', '.join(shown)}{more}")


# ─── Three unrelated menus, to prove the schema does not care ─────────────────

def chicken_shop() -> Menu:
    """Combos, upgrades, a spice attribute, hidden components. Kudo's shape."""
    P = Product
    return Menu(
        business_id="chicken",
        products=[
            P("3PC Chicken", "Chicken", None, portions=3),      # never sold alone
            P("Fries Medium", "Fries", None),                    # never sold alone
            P("Fries Large", "Fries", 20000),                    # also sold alone
            P("Cole Slaw", "Cold", None),
            P("Popcorn Chicken", "Chicken", 28000),
            P("Soda 350ml", "Drinks", 10000),
            P("Soda 1L", "Drinks", None),                        # meal only
            P("Soda 1.25L", "Drinks", 23000),                    # sold alone
            P("3PC Combo", "Combos", 89000),
        ],
        slots=[
            Slot("3PC Combo", "Chicken", 1, 1, [("3PC Chicken", 1, 0, True)]),
            Slot("3PC Combo", "Slaw", 1, 1, [("Cole Slaw", 1, 0, True)]),
            Slot("3PC Combo", "Popcorn", 1, 1, [("Popcorn Chicken", 1, 0, True)]),
            Slot("3PC Combo", "Fries", 1, 1, [
                ("Fries Medium", 1, 0, True), ("Fries Large", 1, 6000, False)]),
            Slot("3PC Combo", "Drink", 1, 1, [
                ("Soda 350ml", 1, 0, True), ("Soda 1.25L", 1, 5000, False)]),
        ],
        attributes=[
            AttrGroup("Spice", [("Normal", 0), ("Spicy", 0)], ["3PC Chicken", "Popcorn Chicken"]),
        ],
        routing=[("Chicken", "Kitchen"), ("Fries", "Kitchen"), ("Cold", "Dispatch"),
                 ("Drinks", "Dispatch")],
    )


def coffee_shop() -> Menu:
    """Size and milk choices, no combos, delta pricing by size. Nothing like Kudo."""
    P = Product
    return Menu(
        business_id="coffee",
        products=[
            P("Espresso Shot", "Coffee", None),
            P("Steamed Milk", "Milk", None),
            P("Oat Milk", "Milk", None),
            P("Latte", "Coffee", 35000),
            P("Croissant", "Pastry", 25000),
        ],
        slots=[
            Slot("Latte", "Size", 1, 1, [
                ("Espresso Shot", 1, 0, True),        # single = 1 shot
                ("Espresso Shot", 2, 8000, False)]),  # double = 2 shots, +80
            Slot("Latte", "Milk", 1, 1, [
                ("Steamed Milk", 1, 0, True), ("Oat Milk", 1, 5000, False)]),
        ],
        attributes=[
            AttrGroup("Temperature", [("Hot", 0), ("Iced", 0)], ["Latte"]),
        ],
        routing=[("Coffee", "Bar"), ("Pastry", "Counter")],
    )


def butchery() -> Menu:
    """Named cuts, priced individually, no slots, no attributes. A flat menu."""
    P = Product
    return Menu(
        business_id="butchery",
        products=[
            P("Beef Sirloin /kg", "Beef", 90000),
            P("Beef Fillet /kg", "Beef", 140000),
            P("Goat Ribs /kg", "Goat", 75000),
            P("Chicken Whole", "Poultry", 60000),
        ],
        # no slots, no attributes, no routing beyond the counter
        routing=[("Beef", "Counter"), ("Goat", "Counter"), ("Poultry", "Counter")],
    )


def main() -> int:
    menus = [("Fried chicken shop", chicken_shop()),
             ("Coffee shop", coffee_shop()),
             ("Butchery", butchery())]
    failures = 0
    for label, menu in menus:
        conn = sqlite3.connect(":memory:")
        conn.executescript(SCHEMA)
        print(f"\n=== {label} ===")
        try:
            load(conn, menu)
            summarize(conn, menu.business_id)
            print("  loaded and validated OK")
        except ImportError_ as e:
            failures += 1
            print(f"  IMPORT REJECTED: {e}")
        conn.close()

    # A deliberately broken menu, to prove validation actually rejects.
    print("\n=== Negative: a slot pointing at a missing product ===")
    bad = coffee_shop()
    bad.slots.append(Slot("Latte", "Syrup", 1, 1, [("Vanilla Syrup", 1, 3000, True)]))
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    try:
        load(conn, bad)
        print("  FAIL: broken menu was accepted")
        failures += 1
    except ImportError_ as e:
        print(f"  correctly rejected: {e}")
    conn.close()

    print(f"\n{'All menus loaded on one schema, no changes.' if failures == 0 else str(failures)+' FAILED'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
