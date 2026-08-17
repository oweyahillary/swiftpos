# 5. Process Flows

Flowcharts and sequence diagrams for the core operational flows.

## 5.1 Sale / checkout (cashier)

```mermaid
flowchart TD
    A[Open / select order] --> B[Add item]
    B --> C{Item type?}
    C -->|simple| D[Add at base price]
    C -->|variant| E[Choose options → base + adjustments]
    C -->|modifier| F[Add modifier prices]
    C -->|weight / PLU| G[Enter qty / scan]
    D & E & F & G --> H[Update cart subtotal]
    H --> I{More items?}
    I -->|yes| B
    I -->|no| J[Apply discount / auto promo]
    J --> K[Server re-prices order\nVAT extracted, total computed]
    K --> L{Hold or pay?}
    L -->|hold| M[status = held]
    L -->|pay| N[Payment flow §5.2]
    N --> O[status = completed]
    O --> P[Deplete stock / ingredients]
    O --> Q[Issue eTIMS invoice §5.4]
    O --> R[Print receipt / KOT • optional WhatsApp]
```

## 5.2 Payment — M-Pesa STK push (sequence)

```mermaid
sequenceDiagram
    actor Cashier
    participant POS as Web/Desktop POS
    participant API as API Server
    participant MP as M-Pesa Daraja
    participant DB as Supabase

    Cashier->>POS: Choose M-Pesa, enter phone
    POS->>API: POST /payments (mpesa, amount, order)
    API->>DB: insert payment (status=pending, mpesa_checkout_id)
    API->>MP: STK push (amount, phone, ref)
    MP-->>Cashier: Prompt on phone (enter PIN)
    MP-->>API: Callback (success/fail)
    API->>DB: update payment status=completed/failed
    API-->>POS: status (poll / realtime)
    POS-->>Cashier: Show paid / retry
```

## 5.3 Shift open → sales → close & reconcile

```mermaid
flowchart TD
    A[Open shift] --> B[Enter opening_float]
    B --> C[status = open]
    C --> D[Cash sales accrue\nvia orders.shift_id]
    C --> E[Float in / out logged]
    D & E --> F[Close shift]
    F --> G[Count drawer + denominations]
    G --> H["expected_cash = opening_float\n+ cash sales + float_in − float_out"]
    H --> I[cash_variance = counted − expected]
    I --> J{Variance = 0?}
    J -->|no| K[Require variance note]
    J -->|yes| L[Confirm]
    K --> L
    L --> M[status = closed; store expected & variance]
    M --> N[Z-report / EOD §5.6]
```

## 5.4 eTIMS e-invoice (sequence)

```mermaid
sequenceDiagram
    participant API as API Server
    participant DB as Supabase
    participant KRA as eTIMS (VSCU/OSCU)

    Note over API: triggered when order completed
    API->>DB: read order, items, branch eTIMS config
    API->>DB: insert etims_invoice (status=pending)
    API->>KRA: send invoice payload (items, taxes, item class codes)
    alt signed
        KRA-->>API: invoice_no, kra_receipt_no, signature, QR
        API->>DB: update status=signed + KRA fields + qr_payload
    else failed
        KRA-->>API: error
        API->>DB: status=failed, retry_count++
        Note over API: retried by background job
    end
```

## 5.5 Offline-first sync

```mermaid
sequenceDiagram
    actor Cashier
    participant POS as Desktop POS (local mode)
    participant Q as sync_queue (local)
    participant API as API Server
    participant DB as Supabase cloud

    Cashier->>POS: Complete sale (offline)
    POS->>Q: enqueue op (idempotency_key, sync_status=pending)
    POS-->>Cashier: receipt (works offline)
    Note over POS: connectivity restored
    POS->>API: push queued ops
    API->>DB: upsert by idempotency_key (no dup)
    DB-->>API: ack
    API-->>POS: results
    POS->>Q: mark synced / conflict
    POS->>DB: pull updates → sync_log
```

## 5.6 EOD / Z-report & reconciliation

```mermaid
flowchart TD
    A[Select day + branch] --> B[Aggregate completed orders]
    B --> C[Revenue, VAT, discounts, voids]
    C --> D[netRevenue = revenue − VAT]
    B --> E[Payment-method split\ncash / mpesa / card / credit-A/R]
    A --> F[Load shifts in range]
    F --> G[Per shift: cash sales, float in/out]
    G --> H["expected_cash; cash_variance"]
    D & E & H --> I[Z-report]
    I --> J{Reconciles?}
    J -->|cash mismatch| K[Investigate variance / deposits]
    J -->|VAT vs eTIMS mismatch| L[Check unsigned eTIMS invoices]
    J -->|ok| M[Day closed]
```

## 5.7 Restaurant — KOT firing & course management

```mermaid
flowchart TD
    A[Items added to dine-in order] --> B{Fire now or hold?}
    B -->|hold| C[fire_status = held]
    B -->|fire| D[fire_status = fired]
    C -->|cashier fires course| D
    D --> E[Create kitchen_ticket per station]
    E --> F[KDS: status = new]
    F --> G[Kitchen: preparing]
    G --> H[ready]
    H --> I[collected / served]
    I --> J{More courses?}
    J -->|yes| B
    J -->|no| K[Settle bill → payment §5.2]
```
