-- A3 (BUG-21): kitchen_tickets was never added to the supabase_realtime publication,
-- so KDS `postgres_changes` never fired and the board only updated on its 30s poll.
-- REPLICA IDENTITY FULL is already set (00_baseline). This is NECESSARY for realtime
-- but NOT sufficient on its own — see A3 in the register: the public /kds display also
-- calls the authed /api/kitchen/tickets (401), and realtime RLS/anon delivery must be
-- verified live. Idempotent + guarded so it is safe on any environment (including a
-- self-hosted stack where the publication may not exist yet).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'kitchen_tickets'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.kitchen_tickets;
  END IF;
END $$;
