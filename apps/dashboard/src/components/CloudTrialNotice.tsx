/**
 * CloudTrialNotice — A569: a small, quiet line for the OWNER in the last 7 days of the cloud trial (lib/cloudTrialNotice.ts).
 * A581: and the cloud plan's notice in the last 14 days before paid-until and while lapsed (planNotice).
 * Asked once per page load (GET /api/business/cloud-trial); nothing for anyone else, and nothing when the call fails.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { usePermissions } from '../context/PermissionsContext';
import { trialNotice, planNotice, type TrialAnswer, type PlanAnswer } from '../lib/cloudTrialNotice';

export default function CloudTrialNotice() {
  const { isOwner, isPartner } = usePermissions();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!isOwner || isPartner) { setText(null); return; }
    let live = true;
    api.get<{ trial: TrialAnswer | null; plan?: PlanAnswer | null }>('/api/business/cloud-trial')
      .then((r) => { if (live) setText(trialNotice(r?.trial) ?? planNotice(r?.plan)); })
      .catch(() => {});
    return () => { live = false; };
  }, [isOwner, isPartner]);
  if (!text) return null;
  return (
    <div data-testid="cloud-trial-notice" role="status"
      className="mx-3 mt-3 md:mx-6 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs">
      {text}
    </div>
  );
}
