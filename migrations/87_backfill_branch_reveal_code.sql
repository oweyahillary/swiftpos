-- =============================================================================
-- 87_backfill_branch_reveal_code.sql
--
-- Give every EXISTING branch a stable tech reveal code (register A114).
--
-- The tech-access doorknock (`branches.tech_reveal_code`) used to be created
-- lazily — only when the admin portal first viewed it or a token was generated.
-- Branches that never hit that path had NULL, so a till cached NULL and the
-- technician "reveal code" stage could never pass (and an offline till could
-- never learn a code minted after it went dark). branch-config now auto-mints on
-- first ask; this migration front-fills the rest so every existing branch has a
-- code immediately, visible in the admin portal and ready to hand to a tech.
--
-- The code MUST match the app generator lib/techToken.ts generateRevealCode():
-- 8 characters from the alphabet 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' (no easily
-- confused 0/O/1/I/L). checkRevealCode() upper-cases + trims before comparing,
-- so this uppercase A–Z/2–9 set matches exactly.
--
-- Per-branch randomness: the cross join to generate_series(1,8) yields 8 rows
-- per null branch, random() is evaluated per row, and string_agg collapses them
-- into one 8-char code per branch (GROUP BY b.id). Idempotent: only touches rows
-- that are still NULL, so re-running is a no-op. Reversible: set the column back
-- to NULL for the affected rows. No schema change.
-- =============================================================================

UPDATE public.branches AS b
SET    tech_reveal_code = sub.code
FROM (
  SELECT br.id,
         string_agg(
           substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
                  1 + floor(random() * 31)::int, 1),
           ''
         ) AS code
  FROM   public.branches br
  CROSS JOIN generate_series(1, 8) AS g(i)
  WHERE  br.tech_reveal_code IS NULL
  GROUP  BY br.id
) AS sub
WHERE  b.id = sub.id
  AND  b.tech_reveal_code IS NULL;
