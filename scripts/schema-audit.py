#!/usr/bin/env python3
"""
schema_audit2.py — cross-check supabase queries against the live schema.

v1 was naive: it flattened nested embeds and blamed the parent table for the
child's columns (e.g. claimed kitchen_tickets lacked `order_type`, when the
select was `kitchen_tickets -> orders ( order_type )`). This version parses the
PostgREST select tree properly and resolves each embed against ITS OWN table.

Real bugs this class catches:
  - orders.pump_id never selected  -> fuel report all zeros
  - qr.ts kitchen_tickets insert   -> 6 phantom columns + invalid status
"""
import re, json, sys
from pathlib import Path
from collections import defaultdict

SCHEMA_INDEX = Path(__file__).parent / 'schema-index.json'
schema = json.load(open(SCHEMA_INDEX))
SRC = Path(__file__).parent.parent / 'apps' / 'server' / 'src'

# Embeds are often aliased or hinted: alias:table!fk(cols), table!inner(cols)
def embed_target(name: str):
    n = name.strip()
    if ':' in n:
        n = n.split(':', 1)[1]
    n = n.split('!')[0].strip()
    return n

def parse_select(s: str):
    """Return (plain_columns, [(embed_name, inner_select), ...])."""
    cols, embeds = [], []
    depth, buf, i = 0, '', 0
    parts = []
    for ch in s:
        if ch == ',' and depth == 0:
            parts.append(buf); buf = ''
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        buf += ch
    if buf.strip():
        parts.append(buf)

    for p in parts:
        p = p.strip()
        if not p:
            continue
        m = re.match(r'^(?P<name>[^()]+)\((?P<inner>.*)\)$', p, re.S)
        if m:
            embeds.append((embed_target(m.group('name')), m.group('inner')))
        else:
            cols.append(p)
    return cols, embeds

AGG = re.compile(r'^(\*|count|sum|avg|min|max)\b', re.I)

def check_select(table, sel, f, problems, seen_tables):
    tcols = schema.get(table)
    if tcols is None:
        problems['missing_table'].add((str(f), table))
        return
    seen_tables.add(table)
    cols, embeds = parse_select(sel)
    for c in cols:
        c = c.strip()
        if not c or AGG.match(c):
            continue
        if ':' in c:                    # alias:real_column
            c = c.split(':', 1)[1].strip()
        c = c.split('::')[0].strip().strip('"').strip("'")
        if not re.match(r'^[a-z_][a-z_0-9]*$', c):
            continue
        if c not in tcols:
            problems['bad_col'].add((str(f), table, c))
    for name, inner in embeds:
        if name not in schema:
            problems['missing_table'].add((str(f), name))
            continue
        check_select(name, inner, f, problems, seen_tables)

problems = defaultdict(set)
seen_tables = set()
n_sel = n_ins = 0

sel_re = re.compile(
    r"\.from\(\s*['\"](?P<tbl>[a-z_]+)['\"]\s*\)"
    r"(?P<mid>(?:\s*\.\w+\((?:[^()]|\([^()]*\))*\))*?)"
    r"\s*\.select\(\s*(?P<q>`(?:[^`])*`|'(?:[^'])*'|\"(?:[^\"])*\")",
    re.S)

ins_re = re.compile(
    r"\.from\(\s*['\"](?P<tbl>[a-z_]+)['\"]\s*\)\s*\.?\s*\n?\s*\.insert\(\s*\{(?P<body>.*?)\n?\s*\}\s*\)",
    re.S)

for f in sorted(SRC.rglob('*.ts')):
    text = f.read_text(errors='ignore')
    rel = str(f).replace(str(SRC) + '/', '')
    for m in sel_re.finditer(text):
        n_sel += 1
        check_select(m.group('tbl'), m.group('q')[1:-1], rel, problems, seen_tables)
    for m in ins_re.finditer(text):
        tbl = m.group('tbl')
        tcols = schema.get(tbl)
        if tcols is None:
            problems['missing_table'].add((rel, tbl)); continue
        body, depth, flat = m.group('body'), 0, []
        for ch in body:
            if ch in '{[(': depth += 1
            elif ch in '}])': depth -= 1
            elif depth == 0: flat.append(ch)
        keys = re.findall(r'(?:^|,)\s*([a-z_][a-z_0-9]*)\s*:', ''.join(flat))
        if not keys: continue
        n_ins += 1
        for k in keys:
            if k not in tcols:
                problems['bad_insert'].add((rel, tbl, k))

print(f"audited {n_sel} selects / {n_ins} inserts across {len(seen_tables)} tables\n")

if problems['missing_table']:
    print("── TABLES REFERENCED IN CODE BUT NOT IN THE DATABASE ──")
    for f, t in sorted(problems['missing_table']):
        print(f"  {t:<22} {f}")
    print()

if problems['bad_insert']:
    print("── INSERT KEYS THAT ARE NOT COLUMNS ──")
    for f, t, c in sorted(problems['bad_insert']):
        print(f"  {t}.{c:<24} {f}")
    print()

if problems['bad_col']:
    print("── SELECTED COLUMNS THAT DO NOT EXIST ──")
    for f, t, c in sorted(problems['bad_col']):
        print(f"  {t}.{c:<24} {f}")
    print()

total = sum(len(v) for v in problems.values())
print(f"total: {total}")
