import SettingsSection from './SettingsSection';
import DevicesTab from './DevicesTab';
import { useBusiness } from '../../context/BusinessContext';
import { foodAreas } from '../../lib/businessTerms';   // A573

// Settings › Devices and printers (register A133).
// Terminals (fleet health) and Devices (enrolment) are two views of the same
// physical estate, previously split between a top-level item and a Staff tab —
// now together. Printers and Print stations join them.
//
// Terminals / Printers / Print stations are rendered by their existing
// standalone page components via the route table (App.tsx); Devices is a panel
// wrapped here.

const TABS = [
  { to: 'terminals', label: 'Terminals' },
  { to: 'devices',   label: 'Devices' },
  { to: 'printers',  label: 'Printers' },
  { to: 'stations',  label: 'Print stations' },
  { to: 'kitchen-display', label: 'Kitchen display' },
];

export default function DevicesPrintersPage() {
  // A573: the kitchen display is a restaurant's or café's (the sidebar's KDS entry already was) — a shop has no kitchen.
  const kds = foodAreas(useBusiness().business?.type).kds;
  return <SettingsSection title="Devices and printers" tabs={kds ? TABS : TABS.filter((t) => t.to !== 'kitchen-display')} />;
}

export function DevicesRoute() {
  return (
    <div className="p-4 sm:p-6">
      <DevicesTab />
    </div>
  );
}
