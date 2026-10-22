/**
 * OtherBranchesPage — A564: Stock › Other branches. Find an item in another branch's stock, ask that branch for it, and
 * answer what other branches ask of yours (Accept and send / Decline). The owner with every branch picked sees every
 * request; with one branch picked, that branch's. The work is OtherBranchesPanel's and the cloud's (routes/stock.ts).
 */
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';
import { usePermissions } from '../../context/PermissionsContext';
import OtherBranchesPanel from '../../components/OtherBranchesPanel';

export default function OtherBranchesPage() {
  const { activeBranchId } = useBranch();
  const { can } = usePermissions();
  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Other branches</h1>
        <p className="text-gray-500 text-sm mt-0.5">
          How much each branch holds of an item{can('inventory.transfer') ? ', and stock one branch asks another for' : ''}
        </p>
      </div>
      <OtherBranchesPanel http={api} canRequest={can('inventory.transfer')} branchId={activeBranchId ?? null} />
    </div>
  );
}
