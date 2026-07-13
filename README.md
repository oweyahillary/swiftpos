# SwiftPOS — Point of Sale System

A multi-tenant POS platform targeting restaurants, cafés, minimarts, petrol stations, and parking operations.

## Current Features

### POS Terminal
- Multi-business-type POS: restaurant (dine-in/takeaway), minimart, parking, petrol
- Live floor plan view with table occupancy (Floor/Grid toggle)
- Piece-based inventory for central kitchen model (e.g. KFC wings)
- Variant and modifier support per product
- M-Pesa STK Push integration (Daraja API)
- Split payment across cash, card, M-Pesa
- Loyalty points earn/redeem at checkout
- Discount codes and auto-applied promotions
- KDS (Kitchen Display System) at `/kds`

### Dashboard (Owner)
- **Cockpit** — live revenue ticker via Supabase realtime, 60-min sparkline, branch comparison
- **Floor Plan Builder** — drag-and-drop table layout with snap-to-grid, zone colour coding
- **Reports (10 tabs)**
  - Master / DSR — full daily sales report
  - Hourly Sales — revenue by hour with channel split
  - Item Mix — product performance with margin
  - Menu Matrix — Stars/Plowhorses/Puzzles/Dogs quadrant analysis
  - Food Cost — ideal vs actual ingredient consumption + variance
  - Aggregators — Bolt/UberEats revenue after commission deduction
  - Voids & Exceptions — voided orders with reasons
  - Tax Report — VAT by period
  - Staff Performance — revenue and orders per cashier
  - SPLH & Labour — sales per labour hour, labour cost %
- **Customers (CRM)** — RFM segments (Loyal/At Risk/New/Lost/Occasional), loyalty tiers
- **Promotions** — Happy Hour, BOGO, Quantity Discount (auto-applied at POS)
- **Webhooks** — outbound HTTP events for `order.completed` / `order.voided` with HMAC signing
- **Inventory** — stock levels, GRN/purchase orders, ingredient tracking, stock adjustments
- **Expenses** — branch-level expense tracking by category
- **Staff Management** — roles, permissions, hourly rates, branch access
- **Restaurant Setup** — tables, zones, service model (pay-first / order-first), menu periods

### Manager Dashboard
- Branch-scoped at `/manager` via PIN login
- Live KPIs: revenue, orders, AOV, VAT, discounts
- Hourly bar chart for today
- Top 5 items of the day
- Active shift SPLH indicator
- Payment method breakdown
- Access to orders, inventory, expenses, customers, staff (scoped to their branch)

---

## Stack

| Layer     | Technology                                      |
|-----------|-------------------------------------------------|
| Frontend  | React 18, TypeScript, Tailwind CSS, Vite        |
| Backend   | Node.js, Express, TypeScript                    |
| Database  | Supabase (PostgreSQL)                           |
| Auth      | Supabase Auth (dashboard) + SwiftPOS JWT (POS)  |
| Payments  | Safaricom Daraja (M-Pesa STK Push)              |
| Realtime  | Supabase Realtime (postgres_changes)            |

---

## Project Structure

```
pos/
├── apps/
│   ├── dashboard/          React frontend (owner + manager)
│   │   └── src/
│   │       ├── components/ DashboardLayout, BranchSelector, ProtectedRoute
│   │       ├── context/    Auth, Business, Branch, Permissions, Theme, POSAuth
│   │       ├── lib/        api.ts, cart.ts, supabase.ts, printing
│   │       └── pages/      All page components
│   └── server/             Express API
│       └── src/
│           ├── middleware/ auth.ts (JWT verification), rbac.ts, validate.ts
│           ├── routes/     One file per resource
│           └── lib/        webhooks.ts, supabase.ts, schemas.ts
└── migrations/             SQL migration files (run in order)
```

---

## Setup

### 1. Environment variables

**`apps/server/.env`**
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_JWT_SECRET=your-jwt-secret
JWT_SECRET=your-random-32-char-secret
PORT=4000
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_PASSKEY=...
MPESA_SHORTCODE=...
MPESA_CALLBACK_URL=https://your-server.com/api/mpesa/callback
```

**`apps/dashboard/.env`**
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_API_URL=http://localhost:4000
```

### 2. Database migrations

Run in order in Supabase SQL editor:
```
migrations/01_promotions.sql
migrations/02_hourly_rate.sql
```

### 3. Run

```bash
# From repo root
pnpm install

# Terminal 1 — API server
cd apps/server && pnpm dev

# Terminal 2 — Dashboard
cd apps/dashboard && pnpm dev
```

---

## URL Routes

| Path                           | Description                           |
|--------------------------------|---------------------------------------|
| `/login`                       | Owner login (Supabase)                |
| `/dashboard`                   | Owner cockpit                         |
| `/dashboard/reports`           | Reports (10 tabs)                     |
| `/dashboard/promotions`        | Promotions management                 |
| `/dashboard/settings`          | Staff management + webhooks           |
| `/dashboard/settings/restaurant` | Floor plan, tables, service config  |
| `/pos`                         | POS entry (PIN login)                 |
| `/pos/cashier`                 | Cashier terminal                      |
| `/manager`                     | Manager dashboard (PIN login)         |
| `/kds`                         | Kitchen Display System (no auth)      |

---

## Business Types

| Type            | POS Screen         | Setup Page              |
|-----------------|--------------------|-------------------------|
| `restaurant`    | CashierScreen (tables) | RestaurantSettingsPage |
| `cafe`          | CashierScreen (tables) | RestaurantSettingsPage |
| `minimart`      | MinimartPOS        | MinimartSettingsPage    |
| `parking`       | ParkingPOS (bays)  | ParkingSettingsPage     |
| `petrol_station`| PetrolPOS (pumps)  | PetrolSettingsPage      |

---

## Pending / Roadmap

- Weekly rota builder (staff scheduling UI)
- Clock in/out at POS via PIN
- Daily summary email notifications
- Product cost price bulk editor
# swiftpos
