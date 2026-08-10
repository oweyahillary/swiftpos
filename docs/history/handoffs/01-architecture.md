# 1. System Architecture

## 1.1 Context diagram

How SwiftPOS sits among its users and external services.

```mermaid
flowchart TB
    owner([Owner / Manager])
    cashier([Cashier])
    kitchen([Kitchen Staff])
    diner([Customer / QR Diner])
    admin([Platform Admin / Agent])

    subgraph SwiftPOS["SwiftPOS Platform"]
        web[Web POS &amp; Dashboard]
        api[API Server]
        db[(Supabase / Postgres)]
        desktop[Desktop POS - local mode]
    end

    mpesa[[M-Pesa Daraja API]]
    etims[[KRA eTIMS]]
    wa[[WhatsApp API]]
    printer[[Thermal Printers]]

    owner --> web
    cashier --> web
    cashier --> desktop
    kitchen --> web
    diner --> web
    admin --> web

    web --> api
    desktop --> api
    api --> db
    api <--> mpesa
    api <--> etims
    api --> wa
    web --> printer
    desktop --> printer
```

## 1.2 Container / component diagram

```mermaid
flowchart LR
    subgraph Client["Client tier"]
        dash["Dashboard (React/Vite)\nPOS screens • Manager • Owner • Reports"]
        desk["Desktop app (Electron)\n*in development*"]
    end

    subgraph Server["API tier (Express/TS)"]
        rOrders["/orders"]
        rPay["/payments • /mpesa"]
        rShifts["/shifts"]
        rReports["/reports • /reports-export"]
        rEtims["/etims"]
        rInv["/inventory • /purchasing"]
        rAuth["/auth • /users • RBAC"]
        rAdmin["/admin (portal)"]
    end

    subgraph Data["Data tier (Supabase)"]
        pg[(PostgreSQL)]
        auth[(Supabase Auth)]
        rt[(Realtime / KDS)]
    end

    subgraph External["External services"]
        mpesa[[M-Pesa]]
        etims[[eTIMS]]
        wa[[WhatsApp]]
    end

    dash --> rOrders & rPay & rShifts & rReports & rEtims & rInv & rAuth
    desk --> rOrders & rPay & rShifts
    rAdmin --> pg
    rOrders --> pg
    rPay --> mpesa
    rPay --> pg
    rEtims --> etims
    rEtims --> pg
    rReports --> pg
    rInv --> pg
    rAuth --> auth
    rt --- dash
    pg --- rt
```

## 1.3 Deployment modes

Each **branch** has a `deploy_mode` of `cloud` or `local`, switchable via an
audited request flow (`mode_switch_requests`).

```mermaid
flowchart TB
    subgraph Cloud["Cloud mode (default)"]
        c1[Browser POS] --> c2[API server]
        c2 --> c3[(Supabase cloud DB)]
    end

    subgraph Local["Local mode (desktop, offline-first)"]
        l1[Desktop POS] --> l2[Local data + sync_queue]
        l2 -. sync when online .-> l3[(Supabase cloud DB)]
    end
```

Offline resilience is built on three tables: `sync_queue` (pending operations with
`retry_count`), `sync_log` (push/pull outcomes), and per-row `sync_status`
(`pending` / `synced` / `conflict`) on transactional tables such as `orders`,
`payments`, and `stock_adjustments`.

## 1.4 Multi-tenancy & access model

```mermaid
flowchart TD
    biz[business] --> br[branch]
    biz --> roles[roles]
    roles --> rp[role_permissions]
    rp --> perms[permissions]
    biz --> users[users]
    users --> ub[user_branches]
    ub --> br
    users --> up[user_permissions overrides]
    biz -. billing .-> subs[subscriptions → plans]
    admins[admin_users] -. scoped tech access .-> br
```

- **Tenant root**: `business` → one or more `branch` rows.
- **Staff**: `users` (PIN-authenticated) assigned to branches via `user_branches`,
  with a `role` granting `permissions`, plus per-user `user_permissions` overrides.
- **Platform staff**: `admin_users` (super_admin / agent) operate the admin portal and
  obtain time-boxed, audited branch access via `tech_access_tokens`.
- **Billing**: `subscriptions` link a business to a `plan` (branch/user caps, features);
  `usage_snapshots` and `feature_flags` govern entitlements.

## 1.5 Tech stack summary

| Concern | Choice | Notes |
|--------|--------|-------|
| Web client | React + TypeScript + Vite | POS + dashboards + reports |
| Desktop client | Electron | Local/offline mode, in development |
| API | Express + TypeScript | REST, server is the money authority (re-prices orders) |
| DB | PostgreSQL via Supabase | RLS, Auth, Realtime |
| Auth | Supabase Auth + PIN | Owners via Auth; cashiers via PIN hash |
| Payments | M-Pesa STK, card, cash, credit | `payments` + `customer_credit_transactions` |
| Tax | KRA eTIMS VSCU/OSCU | `etims_branch_config`, `etims_invoices` |
| Currency | KES, VAT-inclusive @ 16% | VAT extracted from gross |
