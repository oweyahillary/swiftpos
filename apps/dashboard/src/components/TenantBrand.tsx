/**
 * TenantBrand — A378: the client's logo and name at the top of a sign-in page on their own address, and the page shown
 * on an address no business has. See lib/tenant.ts.
 */
import type { TenantInfo } from '../lib/tenant';

/** The client's logo (when they have one) and name, with a small "on SwiftPOS" under it. */
export function TenantBrand({ tenant }: { tenant: TenantInfo }) {
  return (
    <div className="flex flex-col items-center gap-2" data-testid="tenant-brand">
      {tenant.logo && (
        <img src={tenant.logo} alt={tenant.name}
             className="max-h-20 max-w-[220px] object-contain rounded-lg bg-white/5 p-1" />
      )}
      <span className="text-xl font-bold text-white tracking-tight text-center"
            style={tenant.accent ? { color: tenant.accent } : undefined}>
        {tenant.name}
      </span>
      <span className="text-[11px] text-gray-500">on SwiftPOS</span>
    </div>
  );
}

/** An address no business has — no sign-in form (it could not sign anyone in). */
export function UnknownTenantAddress({ subdomain }: { subdomain: string }) {
  return (
    <div data-theme-lock="dark" className="min-h-screen bg-[#080c14] flex items-center justify-center px-4"
         data-testid="tenant-unknown">
      <div className="w-full max-w-sm bg-[#0d1424] border border-[#1e293b] rounded-2xl p-8 text-center space-y-3">
        <div className="text-4xl">🔎</div>
        <h2 className="text-white font-bold text-lg">This address is not set up</h2>
        <p className="text-gray-400 text-sm">
          No SwiftPOS business uses <span className="text-white font-medium">{subdomain}</span>. Check the address with
          your manager, or contact SwiftPOS.
        </p>
      </div>
    </div>
  );
}
