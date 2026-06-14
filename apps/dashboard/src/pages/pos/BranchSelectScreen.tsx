import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useBusiness } from '../../context/BusinessContext';
import { api } from '../../lib/api';

interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_main: boolean;
  status: string;
}

// Stored in sessionStorage so PIN pad knows which branch was selected
export const SELECTED_BRANCH_KEY = 'swiftpos_selected_branch';

export default function BranchSelectScreen() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { business, loading: bizLoading } = useBusiness();

  const [branches, setBranches] = useState<Branch[]>([]);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (authLoading || bizLoading) return;
    if (!user) {
      // Not logged in as owner — redirect to dashboard login
      navigate('/login');
      return;
    }

    Promise.all([
      api.get<Branch[]>('/api/branches'),
      api.get<Record<string, boolean>>('/api/flags'),
    ])
      .then(([b, f]) => {
        setBranches(b.filter((br) => br.status === 'active'));
        setFlags(f);
      })
      .catch(() => setError('Failed to load. Please refresh.'))
      .finally(() => setLoading(false));
  }, [user, authLoading, bizLoading, navigate]);

  function selectBranch(branch: Branch) {
    sessionStorage.setItem(
      SELECTED_BRANCH_KEY,
      JSON.stringify({ id: branch.id, name: branch.name })
    );
    navigate('/pos/pin');
  }

  // ── Feature gate ─────────────────────────────────────────────
  if (!loading && flags['web_cashier_enabled'] === false) {
    return (
      <div style={styles.root}>
        <div style={styles.gate}>
          <div style={styles.gateIcon}>🔒</div>
          <h2 style={styles.gateTitle}>Web POS Not Enabled</h2>
          <p style={styles.gateText}>
            The web cashier is not enabled for this account.
            Contact your administrator to enable it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.logo}>
          <span style={styles.logoMark}>⚡</span>
          <span style={styles.logoText}>SwiftPOS</span>
        </div>
        {business && (
          <div style={styles.bizName}>{business.name}</div>
        )}
      </div>

      {/* Main */}
      <div style={styles.main}>
        <h1 style={styles.title}>Select a Branch</h1>
        <p style={styles.subtitle}>Choose the branch you are working at today</p>

        {loading && (
          <div style={styles.loadingWrap}>
            <div style={styles.spinner} />
            <span style={styles.loadingText}>Loading branches…</span>
          </div>
        )}

        {error && <div style={styles.errorBanner}>{error}</div>}

        {!loading && !error && branches.length === 0 && (
          <div style={styles.emptyState}>
            No active branches found. Add a branch in the dashboard first.
          </div>
        )}

        <div style={styles.grid}>
          {branches.map((branch) => (
            <button
              key={branch.id}
              style={styles.card}
              onClick={() => selectBranch(branch)}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-3px)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 12px 32px rgba(0,0,0,0.18)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#3b82f6';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#e2e8f0';
              }}
            >
              <div style={styles.cardIcon}>
                {branch.is_main ? '🏢' : '📍'}
              </div>
              <div style={styles.cardBody}>
                <div style={styles.cardName}>
                  {branch.name}
                  {branch.is_main && <span style={styles.mainBadge}>Main</span>}
                </div>
                {branch.address && (
                  <div style={styles.cardAddress}>{branch.address}</div>
                )}
                {branch.phone && (
                  <div style={styles.cardPhone}>{branch.phone}</div>
                )}
              </div>
              <div style={styles.cardArrow}>→</div>
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={styles.footer}>
        <a href="/dashboard" style={styles.footerLink}>← Back to Dashboard</a>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0f172a 100%)',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
    color: '#f1f5f9',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '20px 40px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  logoMark: {
    fontSize: 24,
  },
  logoText: {
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: '-0.5px',
    color: '#f1f5f9',
  },
  bizName: {
    fontSize: 14,
    color: '#94a3b8',
    fontWeight: 500,
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '60px 24px 40px',
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.8px',
    margin: '0 0 8px',
    color: '#f1f5f9',
  },
  subtitle: {
    fontSize: 15,
    color: '#94a3b8',
    margin: '0 0 48px',
  },
  grid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    width: '100%',
    maxWidth: 520,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    background: '#1e293b',
    border: '1px solid #e2e8f0',
    borderColor: '#334155',
    borderRadius: 14,
    padding: '18px 22px',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    color: '#f1f5f9',
  },
  cardIcon: {
    fontSize: 28,
    flexShrink: 0,
    width: 44,
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(59,130,246,0.12)',
    borderRadius: 10,
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  cardName: {
    fontSize: 16,
    fontWeight: 600,
    color: '#f1f5f9',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  mainBadge: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.5px',
    textTransform: 'uppercase' as const,
    background: 'rgba(59,130,246,0.2)',
    color: '#60a5fa',
    padding: '2px 7px',
    borderRadius: 20,
  },
  cardAddress: {
    fontSize: 13,
    color: '#64748b',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  cardPhone: {
    fontSize: 12,
    color: '#475569',
    marginTop: 2,
  },
  cardArrow: {
    fontSize: 18,
    color: '#475569',
    flexShrink: 0,
  },
  loadingWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: '40px 0',
    color: '#94a3b8',
  },
  spinner: {
    width: 20,
    height: 20,
    border: '2px solid #334155',
    borderTopColor: '#3b82f6',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  loadingText: {
    fontSize: 14,
  },
  errorBanner: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    color: '#fca5a5',
    borderRadius: 10,
    padding: '12px 20px',
    fontSize: 14,
    marginBottom: 24,
    maxWidth: 520,
    width: '100%',
    textAlign: 'center',
  },
  emptyState: {
    color: '#64748b',
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 360,
    lineHeight: 1.6,
  },
  gate: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    textAlign: 'center',
  },
  gateIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  gateTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: '#f1f5f9',
    margin: '0 0 10px',
  },
  gateText: {
    fontSize: 14,
    color: '#94a3b8',
    maxWidth: 340,
    lineHeight: 1.6,
  },
  footer: {
    padding: '16px 40px',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    textAlign: 'center',
  },
  footerLink: {
    fontSize: 13,
    color: '#64748b',
    textDecoration: 'none',
  },
};
