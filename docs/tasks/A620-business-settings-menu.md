# A620 — Settings › Business: a grouped left menu

**Owner, 2026-11-01:**
- "The top nav is cluttered." This means Settings › Business specifically.
- On Payments: "this is confusing, arrangement is also off, adding M-Pesa integration there makes no sense."
- On Integrations: "a menu left side like the normal navigation where there is a section for webhooks, mpesa, kra … emails
  we can add it in reports."
- On Restaurant setup: "keep off kitchen receipt and Quick notes for orders … should be under printers."

## 1. The menu

Settings › Business replaces its row of up to 13 top tabs with a grouped menu on the left. On a phone, the same menu is a
dropdown above the page.

| Group | Pages |
|---|---|
| Your business | Profile · Branding · Branches |
| Selling | Payments · POS options · Voids, refunds & delivery · Credit approvals · Loss prevention · Scale labels |
| Setup | Restaurant setup (or the business type's own) |
| Integrations | M-Pesa (STK push) · KRA eTIMS · Webhooks |

- Who sees each page is unchanged. M-Pesa is the owner's only, as before (A618). Webhooks are the owner's, or for someone
  with `settings.webhooks`.
- **Users and access** and **Devices and printers** keep their top tabs.

## 2. Moved

- **M-Pesa (STK push):** from Payments to **Integrations › M-Pesa**. The POS messages for "not set up" now say
  "Settings › Business › Integrations › M-Pesa".
- **Tax & compliance:** now **Integrations › KRA eTIMS**. The old links redirect there (`…/business/tax`,
  `/settings/etims`).
- **Webhooks:** now **Integrations › Webhooks**.
- **Report e-mails:** to the **Reports** page, through an **Email schedule** button. The owner and partners see it, as the
  cloud already allows.
- **Keep off the kitchen ticket** and **Quick notes for orders:** from Restaurant setup to **Devices and printers ›
  Printers**, under "Kitchen ticket · every branch". They show for businesses with tables, as before, and the settings
  themselves are unchanged. Restaurant setup now has a link to the new place.

## 3. Payments, in order

1. **Ways to pay:** which methods the POS offers. A branch can choose its own.
2. **Your own payment methods:** Coop Card, Airtel Money, a house account.
3. **Delivery platforms:** Glovo, Uber Eats, Bolt Food prices (A619).

Test: `tests/business-settings-menu-a620.test.mjs`.
