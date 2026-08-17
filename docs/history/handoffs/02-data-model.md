# 2. Data Model

The schema is multi-tenant: nearly every table carries `business_id` (tenant) and most
transactional tables also carry `branch_id`. Money is stored as `numeric` and is
**VAT-inclusive** (`total = subtotal − discount_amount`; `vat_amount` is the VAT embedded
in `total`). The ER diagrams below are grouped by domain for readability; a full table
catalog follows in §2.9.

## 2.1 Tenancy, staff & access control

```mermaid
erDiagram
    businesses ||--o{ branches : "operates"
    businesses ||--o{ users : "employs"
    businesses ||--o{ roles : "defines"
    businesses ||--|| onboarding_progress : "tracks"
    roles ||--o{ role_permissions : ""
    permissions ||--o{ role_permissions : ""
    users }o--|| roles : "has"
    users ||--o{ user_branches : ""
    branches ||--o{ user_branches : ""
    users ||--o{ user_permissions : "overrides"
    permissions ||--o{ user_permissions : ""

    businesses {
        uuid id PK
        string name
        string type "retail|restaurant|cafe|minimart|parking|petrol_station"
        numeric vat_rate "default 16"
        string currency "KES"
        string tax_pin
        bool etims_onboarded
    }
    branches {
        uuid id PK
        uuid business_id FK
        string name
        bool is_main
        string deploy_mode "local|cloud"
        bool desktop_licensed
    }
    users {
        uuid id PK
        uuid business_id FK
        uuid role_id FK
        string name
        string pin_hash
        numeric hourly_rate
    }
    roles {
        uuid id PK
        uuid business_id FK
        string name
        }
    permissions {
        uuid id PK
        string key
        string module
        }
```

## 2.2 Product catalog

```mermaid
erDiagram
    businesses ||--o{ categories : ""
    businesses ||--o{ products : ""
    categories ||--o{ products : "classifies"
    products ||--o{ variant_groups : ""
    variant_groups ||--o{ variant_options : ""
    products ||--o{ modifier_groups : ""
    modifier_groups ||--o{ modifier_options : ""
    products ||--o{ combo_items : "combo→items"

    products {
        uuid id PK
        uuid business_id FK
        uuid category_id FK
        string name
        numeric base_price
        numeric cost_price
        string sold_by "each|weight|volume|piece"
        bool is_fuel
        bool is_combo
        string tax_type "eTIMS A|B|C..."
        string kra_item_class_code
        bool track_stock
    }
    variant_options {
        uuid id PK
        uuid variant_group_id FK
        string name
        numeric price_adjustment
        }
    modifier_options {
        uuid id PK
        uuid modifier_group_id FK
        string name
        numeric price
        }
```

## 2.3 Orders, payments, customers

```mermaid
erDiagram
    orders ||--o{ order_items : ""
    order_items ||--o{ order_item_variants : ""
    order_items ||--o{ order_item_modifiers : ""
    orders ||--o{ payments : "settled by"
    orders }o--|| customers : "for"
    orders }o--|| discounts : "applied"
    orders }o--|| shifts : "during"
    customers ||--o{ loyalty_transactions : ""
    customers ||--o{ customer_credit_transactions : "A/R ledger"
    businesses ||--o{ promotions : ""

    orders {
        uuid id PK
        uuid business_id FK
        uuid branch_id FK
        uuid customer_id FK
        uuid shift_id FK
        uuid cashier_id FK
        string order_number
        string order_type "retail|dine_in|takeaway|delivery|aggregator|parking_session|fuel_sale"
        string status "open|held|completed|voided|refunded"
        numeric subtotal
        numeric discount_amount
        numeric vat_amount
        numeric tip_amount
        numeric total
        string source "pos|qr|aggregator|online"
        string idempotency_key
    }
    payments {
        uuid id PK
        uuid order_id FK
        string method "cash|mpesa|card|credit"
        numeric amount
        numeric amount_tendered
        numeric change_given
        string status "pending|completed|failed|refunded"
        string mpesa_checkout_id
    }
    customers {
        uuid id PK
        string name
        int loyalty_points
        numeric credit_limit
        numeric credit_balance
    }
```

> Note: a `payment` links to a shift only **through** `orders.shift_id` — there is no
> `shift_id` on `payments`. A `credit` payment is **accounts receivable**, recorded in
> `customer_credit_transactions`, not cash collected.

## 2.4 Inventory & purchasing

```mermaid
erDiagram
    products ||--o{ stock_levels : ""
    products ||--o{ stock_movements : ""
    products ||--o{ stock_adjustments : ""
    branches ||--o{ stock_levels : ""
    suppliers ||--o{ purchase_orders : ""
    purchase_orders ||--o{ purchase_order_items : ""
    purchase_orders ||--o{ goods_received_notes : ""
    goods_received_notes ||--o{ grn_items : ""
    stock_transfers ||--o{ stock_transfer_items : ""
    ingredients ||--o{ recipes : "used in"
    products ||--o{ recipes : "BOM"
    ingredients ||--o{ ingredient_stock_movements : ""
    purchase_order_items }o--|| ingredients : ""

    stock_levels {
        uuid id PK
        uuid product_id FK
        uuid branch_id FK
        numeric quantity
        int qty_pieces
        numeric low_stock_threshold
        }
    stock_movements {
        uuid id PK
        uuid product_id FK
        string movement_type "sale|restock|write_off|correction"
        int quantity_change
        int quantity_after
        }
    recipes {
        uuid id PK
        uuid product_id FK
        uuid ingredient_id FK
        numeric quantity_per_serving
        }
```

## 2.5 Restaurant, fuel & parking

```mermaid
erDiagram
    branches ||--o{ tables : ""
    orders ||--o{ kitchen_tickets : "KOT"
    branches ||--o{ reservations : ""
    branches ||--o{ waitlist : ""
    businesses ||--o{ pumps : ""
    businesses ||--o{ fuel_tanks : ""
    pumps }o--|| products : "fuel product"
    fuel_tanks }o--|| products : "fuel product"
    parking_sessions }o--|| tables : "bay"
    parking_sessions }o--|| orders : ""

    tables {
        uuid id PK
        uuid branch_id FK
        string name
        int capacity
        string slot_type "dining|parking_bay"
        numeric rate_per_hour
        }
    kitchen_tickets {
        uuid id PK
        uuid order_id FK
        string station
        string status "new|preparing|ready|collected"
        }
    parking_sessions {
        uuid id PK
        uuid bay_id FK
        string vehicle_plate
        numeric rate_per_hour
        numeric billed_hours
        numeric total_amount
        }
    pumps {
        uuid id PK
        uuid fuel_product_id FK
        string status "idle|dispensing|inactive|error"
        }
```

## 2.6 Shifts, cash & expenses

```mermaid
erDiagram
    shifts ||--o{ float_transactions : ""
    shifts ||--o{ orders : ""
    shifts ||--o{ expenses : ""
    expense_categories ||--o{ expenses : ""
    users ||--o{ clock_events : "time clock"

    shifts {
        uuid id PK
        uuid branch_id FK
        uuid cashier_id FK
        timestamp opened_at
        timestamp closed_at
        string status "open|closed"
        numeric opening_float
        numeric closing_float
        numeric expected_cash
        numeric cash_variance
        jsonb denomination_breakdown
    }
    float_transactions {
        uuid id PK
        uuid shift_id FK
        string type "float_in|float_out"
        numeric amount
        string reason
        }
    expenses {
        uuid id PK
        uuid branch_id FK
        uuid shift_id FK
        numeric amount
        date expense_date
        }
```

## 2.7 Tax & eTIMS (KRA)

```mermaid
erDiagram
    businesses ||--o{ etims_branch_config : ""
    branches ||--|| etims_branch_config : ""
    orders ||--o{ etims_invoices : "e-invoice"
    etims_invoices }o--|| etims_invoices : "credit note → original"

    etims_branch_config {
        uuid id PK
        uuid branch_id FK
        string environment "sandbox|production"
        string mode "vscu|oscu"
        string bhf_id
        string device_serial
        int last_invoice_no
        string status "pending|registered|disabled"
    }
    etims_invoices {
        uuid id PK
        uuid order_id FK
        string invoice_type "sale|credit"
        string status "pending|sent|signed|failed|skipped"
        int invoice_no
        string kra_receipt_no
        string kra_signature
        string qr_payload
        int retry_count
    }
```

## 2.8 Platform, billing, integrations & audit

```mermaid
erDiagram
    plans ||--o{ subscriptions : ""
    businesses ||--o{ subscriptions : ""
    subscriptions ||--o{ invoices : ""
    businesses ||--o{ usage_snapshots : ""
    businesses ||--o{ feature_flags : ""
    businesses ||--o{ api_keys : ""
    businesses ||--o{ webhooks : ""
    webhooks ||--o{ webhook_deliveries : ""
    businesses ||--o{ whatsapp_deliveries : ""
    businesses ||--o{ audit_log : ""
    admin_users ||--o{ admin_audit_log : ""
    admin_users ||--o{ tech_access_tokens : ""
    businesses ||--o{ notifications : ""

    subscriptions {
        uuid id PK
        uuid plan_id FK
        string status "active|expired|cancelled|trial"
        timestamp expires_at
        }
    audit_log {
        uuid id PK
        uuid user_id FK
        string action
        string table_name
        jsonb before_data
        jsonb after_data
        }
    tech_access_tokens {
        uuid id PK
        uuid admin_id FK
        uuid branch_id FK
        timestamp expires_at
        string status
        }
```

## 2.9 Full table catalog

| Domain | Tables |
|--------|--------|
| Tenancy & access | `businesses`, `branches`, `onboarding_progress`, `users`, `user_branches`, `roles`, `permissions`, `role_permissions`, `user_permissions`, `business_settings` |
| Catalog | `categories`, `products`, `variant_groups`, `variant_options`, `modifier_groups`, `modifier_options`, `combo_items` |
| Orders & payments | `orders`, `order_items`, `order_item_variants`, `order_item_modifiers`, `payments`, `discounts`, `promotions`, `customers`, `loyalty_transactions`, `customer_credit_transactions` |
| Inventory & purchasing | `stock`, `stock_levels`, `stock_movements`, `stock_adjustments`, `suppliers`, `purchase_orders`, `purchase_order_items`, `goods_received_notes`, `grn_items`, `stock_transfers`, `stock_transfer_items`, `ingredients`, `ingredient_stock_movements`, `recipes` |
| Restaurant / fuel / parking | `tables`, `kitchen_tickets`, `reservations`, `waitlist`, `pumps`, `fuel_tanks`, `parking_sessions` |
| Shifts & cash | `shifts`, `float_transactions`, `expenses`, `expense_categories`, `clock_events` |
| Tax / eTIMS | `etims_branch_config`, `etims_invoices` |
| Printing | `printer_stations`, `branch_printers`, `receipt_templates`, `printer_template_assignments` |
| SaaS & admin | `plans`, `subscriptions`, `invoices`, `usage_snapshots`, `feature_flags`, `admin_users`, `admin_audit_log`, `admin_client_notes`, `tech_access_tokens`, `tech_approval_flags`, `mode_switch_requests` |
| Integrations & infra | `api_keys`, `webhooks`, `webhook_deliveries`, `whatsapp_deliveries`, `notifications`, `audit_log`, `sync_queue`, `sync_log` |

## 2.10 Key conventions

- **VAT-inclusive money**: `total = subtotal − discount_amount`; `vat_amount = total − total / (1 + vat_rate/100)`.
- **Sync fields**: `sync_status` (`pending|synced|conflict`) on offline-capable tables.
- **Idempotency**: `orders.idempotency_key` prevents duplicate posting on retry/sync.
- **Soft money links**: payments → shift only via `orders.shift_id`; cash sales for a shift
  are cash payments on that shift's orders.
- **A/R**: `credit` payments increment `customers.credit_balance` and post to
  `customer_credit_transactions`.
