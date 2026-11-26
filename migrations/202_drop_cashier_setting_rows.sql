-- 202_drop_cashier_setting_rows.sql — A627: remove the retired cashier-visibility settings' stored rows.
--
-- cashier_sees_shift_sales (A416), cashier_history_totals (A418) and cashier_history_methods (A387) were business/branch
-- settings; A627 turned each into a per-person RIGHT (shifts.see_shift_sales / sales.history_total /
-- sales.history_all_payments), and nothing reads these keys any more. Delete their rows so the cloud carries no leftover.
-- Idempotent: a re-run deletes nothing. Data only — no schema change.

DELETE FROM public.business_settings WHERE key IN ('cashier_sees_shift_sales', 'cashier_history_totals', 'cashier_history_methods');
DELETE FROM public.branch_settings   WHERE key IN ('cashier_sees_shift_sales', 'cashier_history_totals', 'cashier_history_methods');

INSERT INTO public.schema_migrations (version, notes)
VALUES ('202_drop_cashier_setting_rows', 'A627: deleted the retired cashier_sees_shift_sales / cashier_history_totals / cashier_history_methods setting rows (now per-person rights)')
ON CONFLICT (version) DO NOTHING;
