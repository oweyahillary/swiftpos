import { useEffect, useState } from 'react';
import { RELEASE, releaseLabel, releasesDiffer } from '../lib/release';

/**
 * ReleaseBadge — 0.6.28 (owner: "add versioning on the website also so that i can tell which one i am running").
 * "SwiftPOS v0.6.28 · 47a86c9" for this website (the release it was built as, and the commit Vercel built), and the
 * cloud's own from GET /api/version. When the two differ, it says so in amber — one was deployed and the other not yet.
 * `getCloud` is the caller's signed-in fetch (the dashboard's api, or the web POS's posApi); no answer → the cloud line
 * is simply not shown.
 */
type Cloud = { release: string; commit: string | null };

export default function ReleaseBadge({ getCloud, tone = 'dark' }: {
  getCloud?: () => Promise<Cloud>;
  tone?: 'dark' | 'plain';
}) {
  const [cloud, setCloud] = useState<Cloud | null>(null);
  useEffect(() => {
    if (!getCloud) return;
    let live = true;
    getCloud().then((c) => { if (live && c?.release) setCloud(c); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const differ = releasesDiffer(RELEASE, cloud?.release);
  const muted = tone === 'dark' ? '#64748b' : 'inherit';
  return (
    <div data-testid="release-badge" title={`Website built ${__WEB_BUILD_TIME__} from ${__WEB_BUILD_REF__}`}
         style={{ fontSize: 10, lineHeight: 1.5, color: muted, userSelect: 'text' }}>
      <div>ZapTill {releaseLabel(RELEASE, __WEB_BUILD_SHA__)}</div>
      {cloud && (
        <div style={differ ? { color: '#f59e0b' } : undefined} data-testid="release-cloud">
          cloud {releaseLabel(cloud.release, cloud.commit)}{differ ? ' — not the same release as this website' : ''}
        </div>
      )}
    </div>
  );
}
