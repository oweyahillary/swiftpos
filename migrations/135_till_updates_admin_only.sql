-- =============================================================================
-- 135_till_updates_admin_only.sql — A493: approving or holding a client's till version is ZapTill's (the admin portal)
--
-- Owner, 2026-10-15: "update approval should live under admin some clients my not want to pay for updates so they
-- rather not have the ability to do the update them". A490/A491 (migration 134) had made it an owner permission,
-- `settings.updates`, with a Till updates screen; both are gone. The key is retired here the way 134 retired the broad
-- keys: kept registered (old rows may reference it by id), marked replaced, and taken off every role and person.
-- Nothing checks it any more (the cloud refuses PUT /api/controls/updates; the admin portal's PATCH sets the version).
-- Idempotent.
-- =============================================================================

UPDATE public.permissions
   SET module = 'legacy',
       label  = CASE WHEN label LIKE '%(replaced)' THEN label ELSE label || ' (replaced)' END,
       description = 'Retired by A493 — ZapTill approves a client''s till updates in the admin portal, never the client.'
 WHERE key = 'settings.updates';

DELETE FROM public.role_permissions rp USING public.permissions p
 WHERE rp.permission_id = p.id AND p.key = 'settings.updates';
DELETE FROM public.user_permissions up USING public.permissions p
 WHERE up.permission_id = p.id AND p.key = 'settings.updates';

INSERT INTO public.schema_migrations (version, notes)
VALUES ('135_till_updates_admin_only',
        'A493: till update approval is the admin portal''s again; the owner permission settings.updates (A490/134) is retired — marked replaced and removed from every role and person.')
ON CONFLICT (version) DO NOTHING;
