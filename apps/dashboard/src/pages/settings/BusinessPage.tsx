import { useBusiness } from '../../context/BusinessContext';
import { usePermissions } from '../../context/PermissionsContext';   // A550
import { Navigate } from 'react-router-dom';
import SettingsSection, { type SettingsGroup } from './SettingsSection';
import WebhooksTab from './WebhooksTab';
import MpesaStkSettings from './MpesaStkSettings';   // A618, moved to Integrations (A620)
import MpesaNotificationsSettings from './MpesaNotificationsSettings';   // A621: payments to the Till number / Paybill
import RestaurantSettingsPage from './RestaurantSettingsPage';
import MinimartSettingsPage from './MinimartSettingsPage';
import ParkingSettingsPage from './ParkingSettingsPage';
import PetrolSettingsPage from './PetrolSettingsPage';
import { businessTerms, foodAreas } from '@zaptill/core/businessTerms';   // A573

// Settings › Business (register A133).
// One vertical-neutral home for company-level settings. The vertical-specific
// setup page (Restaurant / Minimart / Parking / Petrol) is now ONE tab here,
// resolved by business.type, instead of its own top-level menu item.
//
// NOTE (A134, deferred): a 'Profile' tab — business name, currency, receipt
// header, 24-hour operation — is planned as the first tab. It is the one
// genuinely NEW page in this batch and needs its field list agreed before it is
// built, so it is intentionally NOT shipped here (rule 20: don't ship the thing
// whose decision isn't made yet). Branches/Tax/Payments/Setup/Integrations are
// pure regroupings of existing pages and ship now.

export function useBusinessTabs() {
  return useBusinessGroups().flatMap((g) => g.tabs);
}

/**
 * A620 (owner, 2026-11-01: "under business … the top nav is cluttered"; "under integration we can add a menu left side
 * like the normal navigation where there is a section for webhooks, mpesa, kra"): the Business section's pages in four
 * groups, shown as a left menu. Integrations holds M-Pesa (STK push), KRA eTIMS (was "Tax & compliance") and Webhooks;
 * the report e-mails moved to the Reports page.
 */
export function useBusinessGroups(): SettingsGroup[] {
  const { business } = useBusiness();
  const { can, isOwner } = usePermissions();   // A550: a partner sees the POS options only with settings.pos (the owner holds '*')
  const setupLabel = businessTerms(business?.type).setupLabel;   // A573: Restaurant setup / Retail setup / … (lib/businessTerms.ts)
  const webhooks = isOwner || can('settings.webhooks');   // A595 D3
  return [
    { title: 'Your business', tabs: [
      { to: 'profile',      label: 'Profile' },
      { to: 'branding',     label: 'Branding' },
      { to: 'branches',     label: 'Branches' },
    ] },
    { title: 'Selling', tabs: [
      { to: 'payments',     label: 'Payments' },
      ...(can('settings.pos') ? [{ to: 'pos-options',  label: 'POS options' }] : []),    // A491: the owner's now (was the admin portal's)
      { to: 'voids-refunds', label: 'Voids, refunds & delivery' },   // 0.6.30 (A336 stage 3): the owner's rules; 0.6.33 + free delivery
      ...(isOwner ? [{ to: 'credit-approvals', label: 'Credit approvals' }] : []),   // A585: who approves sales on account — the owner's
      ...(isOwner ? [{ to: 'loss-alerts',  label: 'Loss prevention' }] : []),   // A576: the watch list's switches — the owner's
      ...(can('settings.business') ? [{ to: 'scale-labels', label: 'Scale labels' }] : []),   // A577: weighing-scale barcodes
    ] },
    { title: 'Setup', tabs: [{ to: 'setup', label: setupLabel }] },
    { title: 'Integrations', tabs: [
      ...(isOwner ? [{ to: 'integrations/mpesa', label: 'M-Pesa (STK push)' }] : []),   // A618: the Daraja details are the owner's
      { to: 'integrations/kra', label: 'KRA eTIMS' },
      ...(webhooks ? [{ to: 'integrations/webhooks', label: 'Webhooks' }] : []),
    ] },
  ].filter((g) => g.tabs.length > 0);
}

export default function BusinessPage() {
  const groups = useBusinessGroups();
  return <SettingsSection title="Business" tabs={groups.flatMap((g) => g.tabs)} groups={groups} />;
}

// Vertical setup tab — renders the right settings page for the business type.
// These pages already own their full chrome, so they render as-is.
// A573 (owner, 2026-10-22, on a retail business: "ensure hotel references hav been removed everywere"): a retail shop and
// "other" fell through to the restaurant's page (Dine-in Settings: tables, floor plan, waiters, menu periods). Tables are a
// restaurant's or café's only (foodAreas); every other shop gets the shop's setup (scanner, products and barcodes, bulk
// import). A type not known yet (loading) keeps the restaurant's, as before.
export function VerticalSetupRoute() {
  const { business } = useBusiness();
  switch (business?.type) {
    case 'minimart':       return <MinimartSettingsPage />;
    case 'parking':        return <ParkingSettingsPage />;
    case 'petrol_station': return <PetrolSettingsPage />;
    case 'restaurant':
    case 'cafe':           return <RestaurantSettingsPage />;
    default:               return foodAreas(business?.type).tables ? <RestaurantSettingsPage /> : <MinimartSettingsPage />;
  }
}

// A620: Integrations › … — the first page the section opens on: M-Pesa for the owner, else KRA eTIMS.
export function IntegrationsIndexRoute() {
  const { isOwner } = usePermissions();
  return <Navigate to={isOwner ? 'mpesa' : 'kra'} replace />;
}

// A620: Integrations › Webhooks — outbound webhooks (A595 D3: the owner's, or someone given settings.webhooks).
export function WebhooksRoute() {
  const { can, isOwner } = usePermissions();
  if (!(isOwner || can('settings.webhooks'))) return <p className="p-6 text-sm text-gray-500">Only the owner manages webhooks.</p>;
  return <div className="p-4 sm:p-6"><WebhooksTab /></div>;
}

// A620: Integrations › M-Pesa (STK push) — the Daraja details (A618), the owner's alone. A621: and below them, the
// payment notifications per branch (payments made to the Till number / Paybill, listed on the POS).
export function MpesaRoute() {
  const { isOwner } = usePermissions();
  if (!isOwner) return <p className="p-6 text-sm text-gray-500">Only the owner manages the M-Pesa details.</p>;
  return (
    <div className="max-w-3xl p-4 sm:p-6 space-y-8">
      <MpesaStkSettings />
      <MpesaNotificationsSettings />
    </div>
  );
}
