# PHASE 6 — Branch-local settings, owned by the node

**Status: FOR APPROVAL BEFORE CODE.** Opened 2026-08-10.

Owner's requirement, confirmed point by point:

1. Kitchen exclusions live on the **node**, not the cloud — restaurants have
   different menu items by location or region.
2. Receipt header and footer the same: **branch-local**, not business-wide.
3. A **manager at the branch** can change both, without the owner and without
   internet.
4. Other tills at the branch **reference the node**, cache what they get, and
   pick up edits when they reconnect.
5. Each branch's settings are **backed up to the cloud**, per branch.

Closes register **A24** for its first payload. Vocabulary per rule 21: **node**
is the branch machine, **cloud** is the hosted API. "Server" is not used.

> **THIS IS NOT A NEW DESIGN.** `BRANCH_AUTHORITY_AND_SYNC_DESIGN.md` — which
> six source files cite by section and which was **not in the repository** until
> 2026-08-10 (register A39) — already specifies all of it:
>
> - **§1** "The manager's PC is the branch authority… Edits flow DOWN:
>   Manager PC → tills. Tills never edit reference data and never talk to the
>   cloud directly." That is exactly points 1-4 above.
> - **§5** answers the two-writer question this document had left open.
> - **§4** answers what happens when the web licence lapses.
>
> PHASE6 is that design applied to **settings** rather than prices. Where the two
> disagree, BRANCH_AUTHORITY wins and this document is wrong.

---

## 1. What exists, and why none of it is what was asked for

Rule 17 sweep. There are **two** exclusion mechanisms today and neither is
branch-local:

| | Cloud-backed | Per-till |
|---|---|---|
| Stored | `business_settings.kitchen_exclusions` | browser `localStorage` |
| Edited | web dashboard (`RestaurantSettingsPage.tsx:350`) | Printers tab (`usePrinterSettings`) |
| Reaches the till | `/api/pos/init` → `device_config.kitchen_exclusions` | never leaves the machine |
| Used by | ESC/POS thermal (`escposBridge.ts:421`) | HTML fallback (`printKOT.ts`) |
| Syncs to other tills | yes, via the cloud | **no** |

So the two print paths read **different lists from different places**, and the
one editable at the till is the one that never syncs. Since HTML printing is
still live until thermal is validated, the list a manager would actually edit is
the one with no reach.

**`business_settings` is keyed `(business_id, key)` — there is no `branch_id`.**
A two-branch business changing exclusions for one branch changes both. The
receipt screen states this as if it were reassurance: *"This applies to every
till at the business, not just this one."*

**The precedent already exists.** `branch_prices` (migration 20) exists because
prices differ per branch, resolved `COALESCE(branch_prices.price,
products.base_price)`. Exclusions and receipt text differ for the same reason and
never got the same treatment. This phase applies the shape that is already there.

**What genuinely exists and is kept:** the exclusion *filtering* logic —
`KITCHEN_NOTE_EXCLUDE` (field-approved 2026-08-04, DO NOT MODIFY) and
`kitchenPrepLines()`. The rule stays global and stays the floor. Only storage,
scope, ownership and editing change.

---

## 2. The correction on receipt text

An earlier note in this conversation argued receipt header/footer should stay
owner-only because it carries the KRA PIN. **That was wrong.**
`etims_branch_config` already holds a per-branch `bhf_id` — KRA itself treats
branches as distinct — and the address and phone on that receipt are plainly
branch facts. Per-branch receipt text is correct.

---

## 3. Storage — branch-scoped, node-authoritative, cloud-backed

```sql
CREATE TABLE public.branch_settings (
  branch_id   uuid NOT NULL REFERENCES public.branches(id),
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL DEFAULT 'node'   -- 'node' | 'cloud'
    CHECK (updated_by IN ('node','cloud')),
  PRIMARY KEY (branch_id, key)
);
```

`updated_by` is copied deliberately from `branch_prices`, which uses exactly this
column to detect a both-sides collision during two-way sync. Same problem, same
mechanism.

**Resolution order, mirroring `branch_prices`:**

```
branch_settings(branch_id, key)  →  business_settings(business_id, key)  →  default
```

So a business-wide value keeps working until a branch overrides it, and nothing
breaks on the day this ships.

**The node is authoritative for its branch. The cloud is the durable copy.** That
is the owner's stated model — the node is the source of truth and the only link
to the cloud, with cloud sync serving as backup. A node whose disk dies must not
take the branch's printer configuration with it, and a promoted till (PHASE5 §10)
must be able to recover it.

---

## 4. Per-station exclusions

```sql
ALTER TABLE public.print_stations
  ADD COLUMN IF NOT EXISTS exclude_terms text;
```

Layered, never substituted:

```
KITCHEN_NOTE_EXCLUDE  (global, field-approved, DO NOT MODIFY)
  + branch_settings.kitchen_exclusions   (the branch's list)
  + print_stations.exclude_terms         (this station only)
```

A station may only **add**. A station needing to override the built-in rule is a
conversation with the owner, not a config field.

---

## 5. Distribution — the downstream channel A24 has been asking for

**`GET /node/settings`** — the node serves its branch's settings and station
terms to peers over LAN, behind the existing `X-Node-Secret` and branch scope,
like every other `/node/*` route.

A till resolves in this order:

```
node_url set?  → GET /node/settings        (LAN, no internet needed)
otherwise      → GET /api/pos/init         (cloud, as today)
otherwise      → its own local cache       (device_config)
```

Same authority chain as PHASE5 §4d. **A peer with no internet still gets edits**,
because they come from the node over the LAN — which is the whole point and the
thing that does not work today.

**Why this payload first.** A24 assumed the staff roster would be the first
downstream payload. Printer settings are a better one: if distribution
misbehaves, a ticket prints an item it should not — visible, harmless,
correctable. The same failure with credentials means someone signs in who should
not, or nobody can. This exercises the whole mechanism at a cost measured in
paper.

---

## 6. Editing at the till

Printers tab writes to the **node**, which:

1. applies it locally and serves it to peers immediately;
2. pushes to the cloud when it has internet, stamping `updated_by = 'node'`.

Offline, step 2 queues. The branch keeps working; the backup catches up.

**Retire the `localStorage` copy.** `printKOT` reads the same cached value
`escposBridge` already uses. One source, both print paths — this removes the
whole class of "why is this till different from that one".

---

## 7. Permissions — the franchise case

The owner's point: a franchisee's manager must be able to change their own
branch without head office.

| Setting | Scope | Who edits |
|---|---|---|
| Kitchen exclusions | branch | manager (`settings.manage`) |
| Station terms | station | manager |
| Receipt address / phone | branch | manager |
| KRA PIN line | business | **owner only** |

Today all of these share one gate on the Receipt tab. The PIN line is the one
that should not move on a manager's say-so; the rest are operational and
reversible. **Splitting that gate is part of this work, not a follow-up.**

---

## 8. The two-writer problem — ALREADY SETTLED

This document proposed plain last-write-wins. **BRANCH_AUTHORITY §5 is better and
is the agreed answer.** Adopt it verbatim for settings:

1. Every edit is stamped **who** (`cloud` / `pc`) and **when**, with timestamps
   **server-anchored when the node is online**, so a misset node clock cannot win
   by accident. (`branch-prices.ts:97` already does this.)
2. **Newest wins and applies IMMEDIATELY** — never blocks selling or local
   editing. No approval gate: a branch must be able to change what prints
   without waiting for head office.
3. **Notify only on a TRUE collision** — the same key edited on *both* sides
   since they last agreed. A local edit the cloud never touched is not a
   conflict and syncs silently. This is the important refinement over "notify on
   mismatch": otherwise every ordinary branch edit raises a false alarm.
4. The notification is a **review-after**: the owner **Confirms** (keeps the
   winning value) or **Rejects** (pushes theirs back down → node → tills).
5. Collision and resolution are **logged to an audit trail** — key, both values,
   who won, who confirmed, when.

**The locked-portal worry raised earlier is unfounded, and §4 explains why.**
When web access lapses the portal is locked, so head office *cannot write*.
One writer remains. **"A lapse produces zero conflicts."** Nothing accumulates
that an unlicensed business would be unable to resolve.

The node's value therefore stays live throughout, which is the property that
matters: the branch never waits on anyone.

---

## 8b. One divergence to be explicit about

BRANCH_AUTHORITY §1: *"Tills never edit reference data."* The owner's
requirement is that **a manager edits at the branch without the owner** — which
is the same thing **only if the manager edits on the NODE**.

Editing from an arbitrary peer till would add a second writer inside the branch
and lose the one-writer-per-direction property §1 is built on. So: the Printers
tab is editable **on the node**, and a peer till displays the values read-only.
That is a constraint worth stating in the UI rather than discovering.

## 8c. Stations are created at the branch, not only in the portal

Added 2026-08-10 after the owner asked for a "Barista" station on the till.

**It already exists — on the web dashboard only.** `StationsPage.tsx` has create,
edit, delete and category routing; `routes/stations.ts` has the endpoints behind
`products.manage`. The page even anticipated the request: its header reads *"A
client wanting a 'Barista' station tomorrow meant a code change"* and the New
station placeholder is literally **"Barista"**.

**The licence argument from §7 applies here, harder.** A branch at `locked`
cannot open the portal, so today it cannot create a station at all — it can bind
printers to stations it already has and nothing more. A shop that builds a coffee
counter would have to renew a *web* subscription to tell its own till about it.
A locked portal blocking a price edit is annoying; blocking a new counter means a
section of the shop cannot open.

So station create/edit joins the settings on this screen: **manager-editable at
the branch, `products.manage` — the same permission the dashboard uses — no
internet required.**

**NOT behind the tech screen.** Tech access needs a reveal code and a signed
token, both issued by the admin portal — which is the thing that is locked. That
would route around a closed door using a key kept behind it. It is also the wrong
shape: tech access is for diagnosing a machine, not for a manager adding a
counter they have just built.

### Backed up, and visible to the owner

Owner's requirement, verbatim: *"so that the owner can tell what is happening on
the ground; changes should be backed up and visible on the manager's dashboard."*

Same model as everything else here — **the node is authoritative for its branch,
the cloud is the durable copy**, and the dashboard reads it:

- a station created on the till is written to the node and served to peers
  immediately;
- it is pushed to the cloud when the node has internet, stamped
  `updated_by = 'node'`;
- head office sees it in the portal alongside stations they created themselves,
  so "what is happening on the ground" is answerable without a phone call.

`print_stations` is already in the till's local schema and already synced
downward, so the read path exists. What is missing is the **write** path and the
upward sync — which is exactly the `/node/settings` channel in §5. Station
creation and per-station exclusions are the same screen, the same storage and the
same sync; **building them apart would mean building that sync twice.**

Conflict handling is unchanged: BRANCH_AUTHORITY §5 newest-wins, notify only on a
true collision. A station created at the branch that head office never touched is
not a conflict and syncs silently.

## 9. Sequencing

1. Approve this document.
2. **After 0.5.26 ships and trades a day.** The till should not carry two
   unproven changes into one service.
3. `branch_settings` + `print_stations.exclude_terms` migration — additive.
4. Resolution order server-side; `/api/pos/init` returns the branch value.
5. `/node/settings` and the peer resolution chain.
6. Editing on the Printers tab; retire `localStorage`.
7. Split the permissions.

## 10. What must be tested on real hardware

- Manager edits an exclusion at a **peer** till with the internet cable out; a
  second peer picks it up from the node.
- The node is offline for a day, then reconnects — the edit reaches the cloud
  and the dashboard shows it.
- Two branches, different exclusions, neither leaking into the other.
- A station-specific term applies at that station and nowhere else.
- The built-in sauces/drinks rule still fires with every list empty.
- A manager cannot edit the KRA PIN line; the owner can.
