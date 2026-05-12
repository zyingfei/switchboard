import type { ReactElement } from 'react';

import { FAMILIES, type EdgeFamily } from './edgeKinds';

// Edge-family legend strip rendered in the left rail. Reads
// FAMILIES directly so the legend stays in sync with whatever edge
// kinds the snapshot can produce.
export const FamilyLegend = (): ReactElement => (
  <div className="cx-legend">
    {(Object.keys(FAMILIES) as EdgeFamily[]).map((fam) => {
      const f = FAMILIES[fam];
      return (
        <div key={fam} className="cx-legend-row">
          <span className={`cx-edge fam-${fam}`} aria-hidden>
            <span className="cx-edge-line" />
          </span>
          <span className="cx-legend-text">
            <span className="cx-legend-label">{f.label}</span>
            <span className="cx-legend-desc">{f.description}</span>
          </span>
        </div>
      );
    })}
  </div>
);
