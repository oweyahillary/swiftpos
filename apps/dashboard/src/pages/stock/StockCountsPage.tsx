import { api } from '../../lib/api';
import { useBusiness } from '../../context/BusinessContext';
import { useBranch } from '../../context/BranchContext';
import { usePermissions } from '../../context/PermissionsContext';
import StockCounts from '../../components/StockCounts';

/** Stock › Stock counts — A394: the owner's stock take (components/StockCounts.tsx). */
export default function StockCountsPage() {
  const { business } = useBusiness();
  const { activeBranchId, branches } = useBranch();
  const { permissionKeys } = usePermissions();
  return (
    <div className="p-4 sm:p-8">
      <StockCounts client={api} branchId={activeBranchId} branches={branches} business={business}
        currency={(business as { currency?: string } | null)?.currency || 'KES'} isOwner={permissionKeys.has('*')} />
    </div>
  );
}
