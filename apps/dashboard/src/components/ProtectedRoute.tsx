/**
 * ProtectedRoute — redirects unauthenticated users to /login.
 *
 * Shows a minimal inline skeleton during the cold-boot session check
 * (~50ms on warm cache) instead of a full-page blocking spinner.
 * Once `loading` is false the decision is instant.
 */

import { Navigate, useLocation } from 'react-router-dom';
import { useAuth }  from '../context/AuthContext';
import { usePermissions } from '../context/PermissionsContext';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const { mustChangePassword } = usePermissions();
  const { pathname } = useLocation();

  // Cold-boot only (Supabase reads from its in-memory cache — typically <50ms).
  // We show a minimal skeleton rather than a full-page spinner so the layout
  // shell is visible immediately and the perceived load time is much lower.
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-action-500/60 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  // A568: the owner still has the password the ZapTill agent (or an admin reset) gave them — nothing else until they
  // set their own. The cloud says so on GET /api/auth/session; only a new password clears it.
  if (mustChangePassword && pathname !== '/change-password') return <Navigate to="/change-password" replace />;

  return <>{children}</>;
}
