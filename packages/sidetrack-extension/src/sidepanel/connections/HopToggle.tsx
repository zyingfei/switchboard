import type { ReactElement } from 'react';

// Hop-radius pill group for the anchor bar. The neighbor fetch
// (`/v1/connections/nodes/{id}/neighbors?hops=N`) only meaningfully
// distinguishes 1-hop (direct neighbors) vs 2-hop (neighbors-of-
// neighbors); 3+ get noisy fast. The "Hops" select in the left rail
// still allows 3/4 for power users.
export const HopToggle = ({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (v: number) => void;
}): ReactElement => (
  <div className="cx-pill-group" role="group" aria-label="Hops">
    {[1, 2].map((h) => (
      <button
        key={h}
        type="button"
        className={`cx-pill ${value === h ? 'is-active' : ''}`}
        onClick={() => {
          onChange(h);
        }}
      >
        {h}-hop
      </button>
    ))}
  </div>
);
