# 4. Data Flow Diagrams

DFD notation used here: rounded boxes = **processes**, square boxes = **external
entities**, and `[( … )]` cylinders = **data stores**.

## 4.1 Level 0 — Context diagram

The whole platform as a single process, showing the main data exchanges.

```mermaid
flowchart TB
    cashier[Cashier]
    owner[Owner / Manager]
    diner[QR Diner]
    mpesa[M-Pesa]
    etims[KRA eTIMS]
    wa[WhatsApp]

    P0(("SwiftPOS Platform"))

    cashier -->|cart, tender, shift counts| P0
    P0 -->|receipts, totals, variance| cashier
    diner -->|self-order| P0
    owner -->|config, queries| P0
    P0 -->|reports, dashboards| owner
    P0 -->|STK push request| mpesa
    mpesa -->|payment callback| P0
    P0 -->|invoice payload| etims
    etims -->|receipt no, signature, QR| P0
    P0 -->|receipt message| wa
```

## 4.2 Level 1 — Major processes

```mermaid
flowchart LR
    %% external entities
    cashier[Cashier]
    diner[QR Diner]
    owner[Owner / Manager]
    mpesa[M-Pesa]
    etims[KRA eTIMS]

    %% processes
    P1(("1.0 Order\nManagement"))
    P2(("2.0 Payment\nProcessing"))
    P3(("3.0 Inventory\nControl"))
    P4(("4.0 Tax /\neTIMS"))
    P5(("5.0 Shift &\nCash"))
    P6(("6.0 Reporting"))
    P7(("7.0 Sync\n(offline)"))

    %% data stores
    dOrders[(D1 orders / order_items)]
    dPay[(D2 payments)]
    dStock[(D3 stock / movements)]
    dEtims[(D4 etims_invoices)]
    dShift[(D5 shifts / float)]
    dQueue[(D6 sync_queue)]
    dCust[(D7 customers / credit)]

    cashier -->|line items| P1
    diner -->|QR order| P1
    P1 -->|order record| dOrders
    P1 -->|reduce stock| P3
    P3 --> dStock

    P1 -->|amount due| P2
    cashier -->|tender| P2
    P2 -->|STK push| mpesa
    mpesa -->|callback| P2
    P2 -->|payment record| dPay
    P2 -->|credit / A/R| dCust

    P1 -->|completed sale| P4
    P4 -->|invoice payload| etims
    etims -->|signature, QR| P4
    P4 --> dEtims

    P2 -->|cash in| P5
    cashier -->|float, count| P5
    P5 --> dShift

    dOrders --> P6
    dPay --> P6
    dShift --> P6
    dEtims --> P6
    P6 -->|reports, DSR, Z-report| owner

    P1 -. offline .-> P7
    P2 -. offline .-> P7
    P7 --> dQueue
    P7 -. on reconnect .-> dOrders
```

## 4.3 Level 2 — Payment processing (2.0 expanded)

```mermaid
flowchart TB
    start[Amount due from order]
    method{Tender method?}
    cash[2.1 Record cash\n+ change]
    card[2.2 Record card]
    credit[2.3 Charge to A/R\ncheck credit limit]
    stk[2.4 Initiate STK push]
    cb{Callback result}
    complete[2.5 Mark payment completed]
    fail[2.6 Mark failed / retry]
    dPay[(payments)]
    dCust[(customers / credit ledger)]
    mpesa[M-Pesa]

    start --> method
    method -->|cash| cash --> complete
    method -->|card| card --> complete
    method -->|credit| credit --> dCust
    credit --> complete
    method -->|mpesa| stk --> mpesa
    mpesa --> cb
    cb -->|success| complete
    cb -->|failed/timeout| fail
    complete --> dPay
    fail --> dPay
```

## 4.4 Level 2 — Inventory control (3.0 expanded)

```mermaid
flowchart TB
    sale[Sale completed]
    deplete[3.1 Deplete stock\nby sold qty]
    recipe{Has recipe / BOM?}
    ing[3.2 Deplete ingredients\nper recipe]
    po[3.3 Receive PO → GRN]
    adj[3.4 Manual adjustment]
    xfer[3.5 Branch transfer]
    move[(stock_movements)]
    levels[(stock_levels)]
    ingmove[(ingredient_stock_movements)]

    sale --> deplete --> recipe
    recipe -->|no| levels
    recipe -->|yes| ing --> ingmove
    deplete --> move
    po --> levels
    po --> move
    adj --> levels
    adj --> move
    xfer --> levels
    xfer --> move
```
