import SettingsSection from './SettingsSection';
import DevicesTab from './DevicesTab';

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
];

export default function DevicesPrintersPage() {
  return <SettingsSection title="Devices and printers" tabs={TABS} />;
}

export function DevicesRoute() {
  return (
    <div className="p-6">
      <DevicesTab />
    </div>
  );
}
