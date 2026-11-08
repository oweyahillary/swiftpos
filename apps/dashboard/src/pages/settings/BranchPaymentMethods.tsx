/**
 * BranchPaymentMethods — A429 (owner, 2026-10-10: "add them but as toggles — by default the current payment methods are
 * on but the manager can turn them on or off; add the others but the manager has to turn them on; per branch is also
 * valid and I like it"). Settings › Branches › a branch: each of Kenya's common ways to pay and the delivery apps is a
 * switch for this branch (lib/paymentCatalogue.ts). Not chosen yet = the business default, else the catalogue's defaults
 * (Cash, M-Pesa, Card, Glovo, On account on; the rest off). The tills follow on their next pull, the web POS on its next
 * load. The same switches are on the till: Manager › Settings › Payment methods.
 */
import { PAYMENT_CATALOGUE, enabledFromSetting } from '@zaptill/core/paymentCatalogue';
import { methodColour } from '@zaptill/core/paymentColours';

export default function BranchPaymentMethods({ override, businessDefault, onSave, scope = 'branch' }: {
  /** The branch's own list as stored (a JSON string), or undefined when the branch uses the default. */
  override: string | undefined;
  /** The business's default as stored, if any. */
  businessDefault: string | undefined;
  onSave: (value: string | null) => void;
  /** A490: 'business' — the business-wide list (Settings › Business › Payments) that every branch takes by default. */
  scope?: 'branch' | 'business';
}) {
  const business = scope === 'business';
  const fallback = enabledFromSetting(businessDefault ?? null);
  const enabled = override !== undefined ? enabledFromSetting(override) : fallback;

  const toggle = (code: string) => {
    const next = enabled.includes(code) ? enabled.filter((c) => c !== code) : [...enabled, code];
    onSave(JSON.stringify(enabledFromSetting(next)));
  };

  const group = (title: string, delivery: boolean) => (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1.5">{title}</div>
      <div className="grid gap-1 sm:grid-cols-2">
        {PAYMENT_CATALOGUE.filter((m) => (m.kind === 'delivery') === delivery).map((m) => {
          const on = enabled.includes(m.code);
          return (
            <button key={m.code} type="button" role="switch" aria-checked={on} onClick={() => toggle(m.code)}
              data-testid={`branch-pay-${m.code}`}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-800/60">
              <span className="flex items-center gap-2 min-w-0">
                <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: methodColour(m.code).dot }} />
                <span aria-hidden>{m.icon}</span>
                <span className="truncate">{m.name}</span>
                {m.webOnly && <span className="text-[10px] text-gray-500 whitespace-nowrap">web POS only</span>}
              </span>
              <span className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors ${on ? 'bg-swift-strong' : 'bg-gray-700'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className={business ? '' : 'border-t border-gray-800 pt-4 mt-4'} data-testid={business ? 'business-payment-methods' : 'branch-payment-methods'}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{business ? 'Payment methods the business takes' : 'Payment methods'}</div>
          <div className="text-xs text-gray-600 mt-0.5">
            {business
              ? 'Every branch takes these unless it chooses its own (Settings › Business › Branches › a branch).'
              : override !== undefined ? 'Chosen for this branch' : 'Using the default — switch any method to choose for this branch'}
          </div>
        </div>
        {!business && override !== undefined && (
          <button type="button" onClick={() => onSave(null)} className="text-xs text-gray-400 hover:text-white underline">
            Back to the default
          </button>
        )}
      </div>
      <div className="space-y-3">
        {group('Money', false)}
        {group('Delivery apps', true)}
      </div>
      <p className="text-xs text-gray-600 mt-2">Old sales paid by a method switched off still show in history and reports.</p>
    </div>
  );
}
