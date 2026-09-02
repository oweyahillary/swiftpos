import { useBusiness } from '../../context/BusinessContext';
import SettingsSection from './SettingsSection';
import ReportSchedulerTab from './ReportSchedulerTab';
import WebhooksTab from './WebhooksTab';
import RestaurantSettingsPage from './RestaurantSettingsPage';
import MinimartSettingsPage from './MinimartSettingsPage';
import ParkingSettingsPage from './ParkingSettingsPage';
import PetrolSettingsPage from './PetrolSettingsPage';

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

const SETUP_LABELS: Record<string, string> = {
  restaurant: 'Restaurant setup',
  cafe: 'Café setup',
  minimart: 'Minimart setup',
  parking: 'Parking setup',
  petrol_station: 'Petrol setup',
};

export function useBusinessTabs() {
  const { business } = useBusiness();
  const setupLabel = SETUP_LABELS[business?.type ?? ''] ?? 'Setup';
  return [
    { to: 'profile',      label: 'Profile' },
    { to: 'branches',     label: 'Branches' },
    { to: 'tax',          label: 'Tax & compliance' },
    { to: 'payments',     label: 'Payments' },
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
export function VerticalSetupRoute() {
  const { business } = useBusiness();
  switch (business?.type) {
    case 'minimart':       return <MinimartSettingsPage />;
    case 'parking':        return <ParkingSettingsPage />;
    case 'petrol_station': return <PetrolSettingsPage />;
    case 'restaurant':
    case 'cafe':
    default:               return <RestaurantSettingsPage />;
  }
}

// Integrations tab — outbound webhooks + scheduled report email, both moved out
// of the old Staff Management page.
export function IntegrationsRoute() {
  return (
    <div className="p-6 space-y-10">
      <WebhooksTab />
      <div className="border-t border-gray-800" />
      <ReportSchedulerTab />
    </div>
  );
}
