import { useBusiness } from '../../context/BusinessContext';
import { usePermissions } from '../../context/PermissionsContext';   // A550
import SettingsSection from './SettingsSection';
import ReportSchedulerTab from './ReportSchedulerTab';
import WebhooksTab from './WebhooksTab';
import RestaurantSettingsPage from './RestaurantSettingsPage';
import MinimartSettingsPage from './MinimartSettingsPage';
import ParkingSettingsPage from './ParkingSettingsPage';
import PetrolSettingsPage from './PetrolSettingsPage';
import { businessTerms, foodAreas } from '../../lib/businessTerms';   // A573

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
  const { business } = useBusiness();
  const { can, isOwner } = usePermissions();   // A550: a partner sees the POS options only with settings.pos (the owner holds '*')
  const setupLabel = businessTerms(business?.type).setupLabel;   // A573: Restaurant setup / Retail setup / … (lib/businessTerms.ts)
  return [
    { to: 'profile',      label: 'Profile' },
    { to: 'branding',     label: 'Branding' },
    { to: 'branches',     label: 'Branches' },
    { to: 'tax',          label: 'Tax & compliance' },
    { to: 'payments',     label: 'Payments' },
    { to: 'voids-refunds', label: 'Voids, refunds & delivery' },   // 0.6.30 (A336 stage 3): the owner's rules; 0.6.33 + free delivery
    ...(can('settings.pos') ? [{ to: 'pos-options',  label: 'POS options' }] : []),    // A491: the owner's now (was the admin portal's)
    ...(isOwner ? [{ to: 'loss-alerts',  label: 'Loss prevention' }] : []),   // A576: the watch list's switches — the owner's
    ...(can('settings.business') ? [{ to: 'scale-labels', label: 'Scale labels' }] : []),   // A577: weighing-scale barcodes
    { to: 'setup',        label: setupLabel },
    { to: 'integrations', label: 'Integrations' },
  ];
}

export default function BusinessPage() {
  const tabs = useBusinessTabs();
  return <SettingsSection title="Business" tabs={tabs} />;
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

// Integrations tab — outbound webhooks + scheduled report email, both moved out
// of the old Staff Management page.
export function IntegrationsRoute() {
  return (
    <div className="p-4 sm:p-6 space-y-10">
      <WebhooksTab />
      <div className="border-t border-gray-800" />
      <ReportSchedulerTab />
    </div>
  );
}
