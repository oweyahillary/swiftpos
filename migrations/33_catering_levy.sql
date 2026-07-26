-- SwiftPOS: Catering / Tourism Levy (CTL)
--
-- Kenya's 2% Tourism Levy, administered by the Tourism Fund and successor to the
-- Catering and Tourism Development Levy. Charged on gross sales from food, drinks
-- and accommodation in regulated establishments, on a base that EXCLUDES VAT, and
-- remitted by the 10th of the following month.
--
-- Menu prices are levy- and VAT-inclusive, so a 750 sale at 16% VAT + 2% CTL is:
--
--     net = 750 / 1.18   = 635.59
--     ctl = net * 0.02   =  12.71
--     vat = net * 0.16   = 101.69
--                  total = 750.00
--
-- Note VAT is charged on the net, NOT on net-plus-CTL.
--
-- Stored as a per-business rate rather than a constant so that:
--   • businesses outside the levy's scope (retail, minimart) default to 0 and are
--     wholly unaffected — every calculation collapses to the previous VAT-only one
--   • the rate is configurable if it ever changes, without a code deploy
--   • reports and the transaction path read the SAME number, instead of the
--     transaction path ignoring CTL while reports assumed a hardcoded 2%
--
-- Applicability is the business's own tax question — there is a gross-sales
-- threshold, and registration with the Tourism Fund is separate. This migration
-- only provides the mechanism; it deliberately defaults to 0 (charge nothing).

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS ctl_rate numeric(5, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.businesses.ctl_rate IS
  'Catering/Tourism Levy percentage (e.g. 2.00). 0 = not applicable. Base excludes VAT.';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS ctl_amount numeric(10, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.orders.ctl_amount IS
  'Catering/Tourism Levy for this order, computed at sale time from businesses.ctl_rate.';

-- Backfill is deliberately NOT attempted. Historical orders were priced and rung
-- up without the levy separated; retro-splitting them would invent a tax position
-- for periods already filed. Existing rows keep ctl_amount = 0 and their original
-- vat_amount, which is what was actually charged.
