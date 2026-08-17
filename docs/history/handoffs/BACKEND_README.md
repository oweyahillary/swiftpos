# SwiftPOS — Backend API Reference

Base URL: `http://localhost:4000/api`

All endpoints require an `Authorization: Bearer <token>` header unless noted.

Two token types are accepted:
- **Supabase JWT** — for owner dashboard logins (from Supabase Auth)
- **SwiftPOS JWT** — for POS / manager PIN logins (issued by `POST /api/auth/login`)

---

## Authentication

### POST /api/auth/login
PIN-based login for POS and manager access.
```json
Body:    { "pin": "1234", "business_id": "uuid", "branch_id": "uuid" }
Returns: { "accessToken": "...", "refreshToken": "...", "staff": {...}, "permissions": [...] }
```

### POST /api/auth/refresh
```json
Body:    { "refreshToken": "..." }
Returns: { "accessToken": "..." }
```

---

## Business

### GET /api/business
Returns the authenticated owner's business object.

### GET /api/business/settings
Returns all `key/value` settings for the business.

### POST /api/business/settings
Upserts a single setting.
```json
Body: { "key": "supervisor_pin", "value": "1234" }
```

---

## Branches

### GET /api/branches — list all branches
### POST /api/branches — create branch
### PUT /api/branches/:id — update branch
### PUT /api/branches/:id/set-main — set as main branch
### DELETE /api/branches/:id — deactivate branch
### GET /api/branches/:id/staff — staff assigned to branch
### GET /api/branches/:id/stock — stock levels for branch

---

## Products

### GET /api/products?branch_id=&category_id=&search= — list products
### POST /api/products — create product
### PATCH /api/products/:id — update product
### DELETE /api/products/:id — deactivate product

---

## Categories

### GET /api/categories — list all categories
### POST /api/categories — create category
### PATCH /api/categories/:id — update
### DELETE /api/categories/:id — delete

---

## Orders

### POST /api/orders — create + complete order (pay-first model)
Fires `order.completed` webhook.
```json
Body: {
  branch_id, order_type, items: [{product_id, quantity, unit_price}],
  payment_method, amount_tendered, customer_id?, discount_id?,
  table_id?, aggregator_name?
}
```

### GET /api/orders — list orders
Query: `status`, `date_from`, `date_to`, `search`, `limit`, `offset`

### GET /api/orders/:id — get single order with items + payments

### POST /api/orders/open — open a dine-in order (order-first model)
```json
Body: { branch_id, order_number, table_id, covers? }
```

### POST /api/orders/:id/pay — pay an open order
Fires `order.completed` webhook.
```json
Body: { payment_method, amount_tendered, discount_id?, customer_id? }
```

### POST /api/orders/:id/void — void an order
Requires `orders.void` permission. Paid orders require supervisor PIN.
Fires `order.voided` webhook.
```json
Body: { reason: string, supervisor_pin?: string }
```

---

## Tables (Restaurant)

### GET /api/tables?branch_id= — list active tables
### POST /api/tables — create table (requires `settings.manage`)
```json
Body: { branch_id, name, capacity, sort_order?, zone?, shape? }
```
### PATCH /api/tables/:id — update table position/zone/shape
```json
Body: { name?, capacity?, sort_order?, status?, shape?, zone?, pos_x?, pos_y? }
```
### DELETE /api/tables/:id — soft delete (set inactive)

---

## Shifts

### GET /api/shifts/current — get caller's open shift
### POST /api/shifts/open — open a shift
```json
Body: { branch_id, opening_float }
```
### POST /api/shifts/:id/close — close a shift
```json
Body: { closing_float, notes? }
```
### POST /api/shifts/:id/float — record float in/out
```json
Body: { type: 'float_in'|'float_out', amount, reason? }
```
### GET /api/shifts — list shifts (filters: branch_id, status, from, to)
### GET /api/shifts/:id — get single shift with float transactions + order summary

---

## Staff

### GET /api/staff — list staff members
### POST /api/staff — create staff member
### PATCH /api/staff/:id — update (name, email, role, pin, status, hourly_rate, branch_ids)
### GET /api/staff/roles — list all roles with permissions
### GET /api/staff/permissions — list all available permissions
### PUT /api/staff/roles/:roleId/permissions — replace role permissions
### POST /api/staff/roles — create role

---

## Loyalty / Customers

### GET /api/loyalty/customer?phone= — look up customer by phone
### POST /api/loyalty/customer — create customer
### PATCH /api/loyalty/customer/:id — update customer
### GET /api/loyalty/customers?search=&page=&limit= — paginated list
### GET /api/loyalty/customer/:id/transactions — loyalty transaction history
### GET /api/loyalty/settings — loyalty programme settings

---

## Stock / Ingredients

### GET /api/stock/ingredients — list ingredients
### POST /api/stock/ingredients — create ingredient
### PATCH /api/stock/ingredients/:id — update (name, unit_cost, reorder_level, etc.)
### POST /api/stock/ingredients/:id/adjust — adjust stock quantity
### GET /api/stock/ingredients/:id/movements — movement history

### GET /api/stock/suppliers — list suppliers
### POST /api/stock/suppliers — create supplier

### GET /api/stock/purchase-orders — list GRNs
### POST /api/stock/purchase-orders — create GRN
### PATCH /api/stock/purchase-orders/:id/receive — mark items received (triggers stock increase)

### GET /api/stock/transfers — list transfers
### POST /api/stock/transfers — create transfer between branches

---

## Recipes

### GET /api/recipes — all recipes for business
### GET /api/recipes/:productId — recipe for one product
### POST /api/recipes/:productId — full replace recipe lines
```json
Body: { lines: [{ ingredient_id, quantity_per_serving, unit? }] }
```
### DELETE /api/recipes/:productId — clear recipe

---

## Inventory

### GET /api/inventory?branch_id= — current stock levels
### POST /api/inventory/adjust — manual stock adjustment

---

## Reports

All report endpoints accept: `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `branch_id`

| Endpoint                    | Description                                         |
|-----------------------------|-----------------------------------------------------|
| GET /api/reports/sales      | Revenue, orders, AOV, payment methods, daily series |
| GET /api/reports/products   | Basic product sales by category                     |
| GET /api/reports/products-v2| Item Mix with margin % (feeds Menu Matrix)          |
| GET /api/reports/staff      | Revenue and orders per cashier                      |
| GET /api/reports/inventory  | Stock movements (sold, restocked, adjusted)         |
| GET /api/reports/eod        | End-of-day summary with cash drawer reconciliation  |
| GET /api/reports/shifts     | Shift list with float and order totals              |
| GET /api/reports/master     | Master / DSR report (Posist-style)                  |
| GET /api/reports/hourly     | Revenue and orders by hour of day                   |
| GET /api/reports/voids      | Voided orders with reasons and cashier              |
| GET /api/reports/tax        | VAT collected by period                             |
| GET /api/reports/food-cost  | Ideal vs actual ingredient consumption + variance   |
| GET /api/reports/aggregator | Revenue by aggregator platform after commission     |
| GET /api/reports/splh       | Sales per labour hour + labour cost %               |

---

## Promotions

### GET /api/promotions — list all promotions
### POST /api/promotions — create promotion
```json
Body: {
  name, promo_type: 'happy_hour'|'bogo'|'quantity_discount',
  start_time?, end_time?, days_of_week?, start_date?, end_date?,
  applies_to: 'all'|'product'|'category',
  discount_type?: 'percentage'|'fixed', discount_value?,
  min_quantity?, free_quantity?
}
```
### PATCH /api/promotions/:id — update promotion
### DELETE /api/promotions/:id — delete promotion
### GET /api/promotions/active?product_ids=&category_ids= — active promotions right now

---

## Webhooks

### GET /api/webhooks — list all endpoints
### POST /api/webhooks — create endpoint (returns secret once)
```json
Body: { url, events: ['order.completed','order.voided'] }
Returns: { ...webhook, secret: 'whsec_...' }
```
### PATCH /api/webhooks/:id — update URL, events, or status
### DELETE /api/webhooks/:id — delete endpoint
### GET /api/webhooks/:id/deliveries — last 50 delivery attempts
### POST /api/webhooks/:id/test — send a test ping

**Webhook payload format:**
```json
{
  "event": "order.completed",
  "created_at": "2026-01-01T12:00:00Z",
  "data": {
    "order_id": "uuid",
    "order_number": "ORD-123456-789",
    "order_type": "dine_in",
    "total": 1500.00,
    "branch_id": "uuid",
    "cashier_id": "uuid"
  }
}
```

**Signature verification:**
```
X-SwiftPOS-Signature: sha256=<hmac-sha256(secret, raw_body)>
X-SwiftPOS-Event: order.completed
X-SwiftPOS-Delivery: <delivery_uuid>
```

---

## Discounts

### GET /api/discounts — list discounts
### POST /api/discounts — create discount (percentage or fixed, with optional promo code)
### PUT /api/discounts/:id — update discount
### PATCH /api/discounts/:id/toggle — activate / deactivate
### DELETE /api/discounts/:id — delete
### POST /api/discounts/apply — validate and apply a discount at POS
```json
Body:    { "code"?: "SAVE10", "discount_id"?: "uuid", "order_total": 1500 }
Returns: { "discount": {...}, "discount_amount": 150 }
```

---

## Expenses

### GET /api/expenses?branch_id=&from=&to= — list expenses
### POST /api/expenses — create expense
### DELETE /api/expenses/:id — delete expense
### GET /api/expenses/categories — list expense categories

---

## Notifications

### GET /api/notifications?limit= — list notifications
### PATCH /api/notifications/:id/read — mark as read
### PATCH /api/notifications/read-all — mark all as read

---

## Printers

### GET /api/printers?branch_id= — list printers for branch
### POST /api/printers — create printer
### PATCH /api/printers/:id — update
### DELETE /api/printers/:id — delete

---

## M-Pesa

### POST /api/mpesa/stk-push — initiate STK push payment
### POST /api/mpesa/callback — Daraja callback (no auth)
### GET /api/mpesa/status/:checkoutRequestId — poll payment status

---

## Permission Keys

| Key                  | Description                          |
|----------------------|--------------------------------------|
| `*`                  | Wildcard — all permissions (owners)  |
| `orders.create`      | Create and complete orders           |
| `orders.hold`        | Hold/park orders                     |
| `orders.void`        | Void orders                          |
| `orders.refund`      | Process refunds                      |
| `orders.view_all`    | View all orders (not just own)       |
| `products.view`      | View products                        |
| `products.manage`    | Create/edit/delete products          |
| `inventory.view`     | View stock levels                    |
| `inventory.adjust`   | Adjust stock                         |
| `customers.view`     | View CRM                             |
| `customers.manage`   | Create/edit customers                |
| `discounts.apply`    | Apply discounts at POS               |
| `discounts.manage`   | Create/edit discounts                |
| `reports.view`       | View reports                         |
| `reports.export`     | Export reports                       |
| `staff.manage`       | Manage staff members                 |
| `settings.manage`    | Access settings pages                |
| `expenses.view`      | View expenses                        |
| `expenses.manage`    | Create/delete expenses               |
| `payments.cash`      | Accept cash payments                 |
| `payments.card`      | Accept card payments                 |
| `payments.mpesa`     | Accept M-Pesa payments               |
| `kitchen.view`       | View kitchen display                 |
| `kitchen.manage`     | Update ticket status                 |
