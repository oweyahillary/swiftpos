import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';
import Wastage from '../../components/Wastage';

/** Stock › Wastage — A399: the owner's wastage log (components/Wastage.tsx). */
export default function WastagePage() {
  const { business } = useBusiness();
  const { activeBranchId, branches } = useBranch();
  return (
    <div className="p-4 sm:p-8">
      <Wastage client={api} branchId={activeBranchId} branches={branches}
        currency={(business as { currency?: string } | null)?.currency || 'KES'} />
    </div>
  );
}
