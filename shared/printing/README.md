# shared/printing

Ticket rendering for the POS. Turns an order into the bytes a thermal printer
wants, for any number of stations.

Nothing here imports from the existing print code. `printReceipt`, `printKOT`,
`printDispatcher`, `thermal`, `ticketLines`, `qzTray`, `usePaperGeometry` and
`apps/print-server` are all replaced by this package — do not wire it alongside
them, wire it instead of them.

## Where this goes

Master copy lives here, at `shared/printing/`, matching the convention already
used by `shared/parkingTariff.ts`. When wiring, copy the folder into the app
that consumes it:

    shared/printing/                    <- master, edit here
    apps/desktop/src/shared/printing/   <- copy, for the Electron main process

`escpos.ts` uses `Buffer`, so it is Node-only. Everything else — including
`preview.ts` — is pure and runs in a browser, which is what lets the settings
screen preview without a printer attached.

## Running it

    cd shared/printing
    npm install
    npx tsc
    node dist/test/sample.js

That renders the sample order to all three stations plus a duplicate, on both
80mm and 58mm, and checks the tax arithmetic against two receipts photographed
from the incumbent system. `SAMPLE-OUTPUT.txt` is a captured run.

Compiles clean under `strict: true`. The three app tsconfigs are currently
`strict: false`; do not relax this one to match them.

## How it fits together

    order + business + station config
              |
              v
        render.ts  ->  Document  ->  escpos.ts  -> bytes -> printer
                            |
                            +----->  preview.ts -> text  -> settings screen

The `Document` in the middle is the point. Both serialisers consume the same
one, so the settings preview is not a second implementation of the layout that
can disagree with the first. A preview that looks right IS right.

## Stations are flags, not types

Kitchen, dispatch and receipt are one renderer under three sets of flags. There
is no `isCombo`, no hardcoded list of three ticket kinds, and no per-client
branching. A restaurant with a bar, a grill, a cold pass, a dispatch bench and a
till configures five stations off the same struct.

`kitchenPreset` / `dispatchPreset` / `receiptPreset` in `index.ts` exist so a new
business has working stations on day one. Copy one and change the flags.

## Decisions still open

Marked `(UNSETTLED)` in `index.ts` so they are greppable. Each currently matches
the approved mockups; each is one boolean.

  emphasizeParent      double-height dish names on the kitchen ticket
  aggregateUnits       collapse identical units across lines, vs per-parent
  showFooterCount      the "5 items to cook" / "3 bags" line
  showOptionPrices     net price deltas beneath a receipt line
  attributeStyle       inline when simple, vs always on a sub-line

Two deviations from the drawn mockups, both deliberate:

  - Attribute sub-lines print the full unit name (`3PC Chicken  1 spicy, 2
    normal`) rather than a shortened one. Auto-abbreviating a product name is
    guesswork.
  - 80mm is 48 columns, not the 42 that was drawn. 42 is Font B; Font A is
    wider and materially easier to read across a counter. Same arrangement,
    more room.

## Not built yet

  - Transport. Raw TCP to port 9100, USB/serial device handle, and the Win32
    spooler with pDatatype="RAW" so the job skips GDI rendering entirely.
  - The spool. A SQLite `print_jobs` table with per-station queues, retry and
    backoff, so the till never blocks on a printer and an offline station
    catches up when it returns.
  - eTIMS. No fiscal QR or control unit block, because it has not been
    specified. Absent rather than faked.
  - Logo bitmaps. Text headers only for now.
