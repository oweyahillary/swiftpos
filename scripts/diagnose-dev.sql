-- diagnose-dev.sql — run once:  psql "$DATABASE_URL" -f scripts/diagnose-dev.sql
-- Use the SAME DATABASE_URL the dev SERVER uses (from Render env), so we are
-- looking at the database the web actually reads. Answers three questions at once.

\echo '========================================================================'
\echo 'Q1  Is migration 89 on THIS database? (expect: payments_method_format_check, len 40)'
\echo '========================================================================'
SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.payments'::regclass AND conname LIKE 'payments_method%';

SELECT character_maximum_length AS method_column_length
FROM information_schema.columns
WHERE table_name = 'payments' AND column_name = 'method';

\echo ''
\echo '========================================================================'
\echo 'Q2  Did sales actually reach THIS database? (orders per EAT calendar day)'
\echo '========================================================================'
SELECT (created_at AT TIME ZONE 'Africa/Nairobi')::date AS eat_day,
       count(*) AS orders,
       round(sum(total), 2) AS total_value
FROM public.orders
WHERE created_at >= now() - interval '5 days'
GROUP BY 1 ORDER BY 1 DESC;

\echo ''
\echo '========================================================================'
\echo 'Q3  What payment methods were recorded in the last 5 days?'
\echo '     (custom codes here = custom-method sales DID sync)'
\echo '========================================================================'
SELECT p.method, count(*) AS legs, round(sum(p.amount), 2) AS amount
FROM public.payments p
WHERE p.created_at >= now() - interval '5 days'
GROUP BY p.method ORDER BY legs DESC;
