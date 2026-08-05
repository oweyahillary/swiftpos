-- ─────────────────────────────────────────────────────────────────────────────
-- adjust_product_stock — atomic per-branch product stock change
--
-- WHY THIS EXISTS
-- The product restock, transfer, void-restore and refund-restore paths all did
-- read-modify-write in JavaScript:
--
--     const newQty = (current?.quantity ?? 0) + item.quantity;
--
-- Two independent bugs lived in that one line.
--
-- 1. STRING CONCATENATION. PostgREST returns numeric(12,2) as a STRING, so
--    `current.quantity` was "10.00", not 10. "10.00" + 2 is the string
--    "10.002", which either rounds to 10.01 on the way back in (receiving 5
--    units added one cent of stock) or, when both operands were strings on the
--    void path, produced "10.002.00" — not a valid numeric, so the write
--    silently failed and stock was NEVER restored on a void. Deduction used
--    subtraction, which coerces to a number, so deducting worked and restoring
--    did not. That asymmetry is exactly why it stayed invisible: the shelf went
--    down correctly and never came back up.
--
-- 2. LOST UPDATE. Even with correct types, read-then-write is a race. Two tills
--    receiving the same product at once both read 10, both write 15, and five
--    units vanish. The ingredient path already avoided this with an atomic RPC
--    (adjust_ingredient_stock, migration 23); products never got the same
--    treatment. This function is that treatment.
--
-- The addition now happens inside Postgres, in numeric arithmetic, under the
-- row lock ON CONFLICT takes. Both bugs are closed by construction: there is no
-- JavaScript number, and there is no read-modify-write window.
--
-- p_piece_delta is applied to qty_pieces for piece-sold products; pass 0 for
-- weight/unit products. Both counters move in the same locked statement so they
-- can never drift apart under concurrency.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.adjust_product_stock(
  p_product_id   UUID,
  p_branch_id    UUID,
  p_qty_delta    NUMERIC,
  p_piece_delta  INTEGER DEFAULT 0
)
RETURNS TABLE (quantity NUMERIC, qty_pieces INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
  v_qty    NUMERIC;
  v_pieces INTEGER;
BEGIN
  INSERT INTO public.stock_levels (product_id, branch_id, quantity, qty_pieces)
  VALUES (p_product_id, p_branch_id, p_qty_delta, GREATEST(p_piece_delta, 0))
  ON CONFLICT (product_id, branch_id) DO UPDATE
    SET quantity   = public.stock_levels.quantity + p_qty_delta,
        qty_pieces = public.stock_levels.qty_pieces + p_piece_delta,
        updated_at = NOW()
  RETURNING public.stock_levels.quantity, public.stock_levels.qty_pieces
    INTO v_qty, v_pieces;

  quantity   := v_qty;
  qty_pieces := v_pieces;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.adjust_product_stock IS
  'Atomic per-branch product stock delta. Replaces JS read-modify-write, which both '
  'corrupted numeric values via string concatenation and lost updates under concurrency.';
