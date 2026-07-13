/**
 * ProtectedRoute — redirects unauthenticated users to /login.
 *
 * Shows a minimal inline skeleton during the cold-boot session check
 * (~50ms on warm cache) instead of a full-page blocking spinner.
 * Once `loading` is false the decision is instant.
 */

import { Navigate } from 'react-router-dom';
import { useAuth }  from '../context/AuthContext';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();

  // Cold-boot only (Supabase reads from its in-memory cache — typically <50ms).
  // We show a minimal skeleton rather than a full-page spinner so the layout
  // shell is visible immediately and the perceived load time is much lower.
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-green-500/60 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  return <>{children}</>;
}
