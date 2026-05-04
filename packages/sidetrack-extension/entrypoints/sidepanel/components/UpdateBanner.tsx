import { useEffect, useState } from 'react';

import { Icons } from './icons';

// Companion-update advisory banner. Polls the companion's
// /v1/system/update-check endpoint (shipped in PR #77) every 6h while
// the panel is open and surfaces a one-line "update available" prompt
// when current < latest. Dismiss is per-session (resets on reload);
// the actual update-execution gate ships separately.

interface UpdateAdvisory {
  readonly current: string;
  readonly latest: string | null;
  readonly behind: boolean;
  readonly ageDays: number | null;
  readonly releasedAt: string | null;
  readonly warning?: string;
}

interface UpdateBannerProps {
  readonly companionPort: number | null;
  readonly bridgeKey: string | null;
  readonly onUpdate?: (advisory: UpdateAdvisory) => void;
}

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export function UpdateBanner({ companionPort, bridgeKey, onUpdate }: UpdateBannerProps) {
  const [advisory, setAdvisory] = useState<UpdateAdvisory | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (companionPort === null || bridgeKey === null) {
      return undefined;
    }
    let cancelled = false;
    const fetchAdvisory = async () => {
      try {
        const url = `http://127.0.0.1:${String(companionPort)}/v1/system/update-check`;
        const response = await fetch(url, {
          headers: { 'x-bac-bridge-key': bridgeKey },
        });
        if (!response.ok) return;
        const body = (await response.json()) as { readonly data?: UpdateAdvisory };
        if (cancelled || body.data === undefined) return;
        setAdvisory(body.data);
      } catch {
        // Silent — the banner just doesn't show.
      }
    };
    void fetchAdvisory();
    const id = window.setInterval(() => {
      void fetchAdvisory();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [companionPort, bridgeKey]);

  if (advisory === null || !advisory.behind || dismissed) {
    return null;
  }

  const ageNote =
    advisory.ageDays !== null
      ? `released ${String(advisory.ageDays)} day${advisory.ageDays === 1 ? '' : 's'} ago`
      : null;

  return (
    <div className="sp-banner info" role="status">
      <span className="b-glyph">{Icons.refresh}</span>
      <div className="b-body">
        <b>
          Companion update — {advisory.current} → {advisory.latest ?? '?'}
        </b>
        {ageNote !== null ? <span className="muted">{ageNote}</span> : null}
      </div>
      <div className="b-actions">
        <button
          type="button"
          className="b-ghost"
          onClick={() => {
            setDismissed(true);
          }}
        >
          Later
        </button>
        <button
          type="button"
          className="b-primary"
          onClick={() => {
            onUpdate?.(advisory);
          }}
        >
          Update
        </button>
      </div>
    </div>
  );
}
