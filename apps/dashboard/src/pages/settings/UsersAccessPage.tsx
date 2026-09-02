import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import SettingsSection from './SettingsSection';
import StaffTab from './StaffTab';
import RolesTab from './RolesTab';

// Settings › Users and access (register A133).
// Consolidates the staff/roles half of the old Staff Management page.

interface Branch { id: string; name: string; is_main: boolean; }

const TABS = [
  { to: 'staff', label: 'Staff members' },
  { to: 'roles', label: 'Roles and permissions' },
];

export default function UsersAccessPage() {
  const [branches, setBranches] = useState<Branch[]>([]);

  useEffect(() => {
    api.get<Branch[]>('/api/branches')
      .then(data => setBranches(data ?? []))
      .catch(() => {});
  }, []);

  return <SettingsSection title="Users and access" tabs={TABS} context={{ branches }} />;
}

// Child route wrappers — kept here so the section owns its data (branches).
export function StaffMembersRoute() {
  const { branches } = useOutletContext<{ branches: Branch[] }>();
  return (
    <div className="p-6">
      <StaffTab branches={branches} />
    </div>
  );
}

export function RolesRoute() {
  return (
    <div className="p-6">
      <RolesTab />
    </div>
  );
}
