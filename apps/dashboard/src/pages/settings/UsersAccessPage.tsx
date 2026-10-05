import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import SettingsSection from './SettingsSection';
import StaffTab from './StaffTab';
import RolesTab from './RolesTab';
import ChangePassword from '../../components/ChangePassword';   // A402
import SignInSecurity from '../../components/SignInSecurity';

// Settings › Users and access (register A133).
// Consolidates the staff/roles half of the old Staff Management page.

interface Branch { id: string; name: string; is_main: boolean; }

const TABS = [
  { to: 'staff', label: 'Staff members' },
  { to: 'roles', label: 'Roles and permissions' },
  { to: 'security', label: 'My sign-in' },   // A391: the owner's sign-in code
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
      <StaffTab branches={branches} canResetSignIn />
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

// A391: the owner's own sign-in code — email or an authenticator app.
export function SignInSecurityRoute() {
  return (
    <div className="p-6 space-y-8">
      <SignInSecurity />
      {/* A402: the owner's password */}
      <ChangePassword />
    </div>
  );
}
