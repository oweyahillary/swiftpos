import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';
import Expiry from '../../components/Expiry';

/** Stock › Expiry — A413: batches and expiry dates (components/Expiry.tsx). */
export default function ExpiryPage() {
  const { business } = useBusiness();
  const { activeBranchId } = useBranch();
  return (
    <div className="p-4 sm:p-8">
      <Expiry client={api} branchId={activeBranchId}
        currency={(business as { currency?: string } | null)?.currency || 'KES'} />
    </div>
  );
}
