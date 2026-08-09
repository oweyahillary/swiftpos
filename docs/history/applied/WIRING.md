# Wiring the device-branch binding

Migration 52 and `lib/deviceBinding.ts` are the mechanism. Three small edits
switch it on, and one screen makes relocation possible without a developer.

## 1. Refuse a moved terminal's pushes — `routes/sync.ts`

At the top of the push handler, before any arm runs:

```ts
import { checkDeviceBranch } from '../lib/deviceBinding';

const binding = await checkDeviceBranch(businessId, req.body?.device_id, req.body?.branch_id);
if (!binding.ok) {
  res.status(409).json({ error: binding.error, code: binding.code });
  return;
}
```

409, not 403: the request is well formed, the terminal is simply not where it
says it is. The till already treats a non-200 as retryable, so the sales stay on
the machine and go up once the branch is corrected. Nothing is lost.

Do the same in `POST /api/orders` if the payload carries `branch_id`.

## 2. Check the terminal code during setup — `routes/devices.ts`

```ts
import { isTerminalCodeTaken } from '../lib/deviceBinding';

router.get('/terminal-code-available', async (req, res) => {
  const { branch_id, code, device_id } = req.query as Record<string, string>;
  if (!branch_id || !code) { res.status(400).json({ error: 'branch_id and code are required' }); return; }
  const taken = await isTerminalCodeTaken(req.businessId, branch_id, code, device_id);
  res.json({ available: !taken });
});
```

Call it from `InstallPage` when the terminal code field loses focus. The unique
index is the real guarantee; this exists so the installer finds out while still
on the screen where they can change it.

## 3. Authorise a relocation — dashboard, Settings → Terminals

A manager action that sets:

```sql
UPDATE user_devices
   SET rebind_allowed_until = now() + interval '60 minutes',
       rebind_authorised_by = :staff_id
 WHERE id = :device_id;
```

Gate it on `settings.manage`, the same permission as device approval. The window
closes itself, and the next sync from that till takes it up and clears it.

**Tell the manager to check the terminal code first.** A move into a branch that
already has that code is refused — the test proves it — and the message says so,
but it is friendlier to catch it before the trip than after.

## What a moved till looks like

Without authorisation, from the shop floor: sales ring normally, sync shows
pending, and the error names the cause — *"This terminal is registered to a
different branch."* The cash is in the drawer, the orders are on the till, and
nothing reaches the wrong branch's books.

## What this does not stop

Someone reinstalling the app to clear `device_config` and registering as a new
device. That is a bigger action leaving a bigger trace: a new row in the fleet
view, a device pending approval, and `clearDeviceConfig()` is already logged as
ungated in the audit. Worth closing next.
