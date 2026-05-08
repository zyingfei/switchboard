import type { ReactElement } from 'react';

import { reasonConfidence, type Reason } from './why-related/reasons';
import { renderReason } from './why-related/render';
import { sortReasons } from './why-related/sort';

export interface WhyRelatedPanelProps {
  readonly fromVisitId: string;
  readonly toVisitId?: string;
  readonly toTopicId?: string;
  readonly reasons: readonly Reason[];
  readonly showOnlyUserAsserted: boolean;
  readonly onToggleAssertedOnly: () => void;
  readonly onClose: () => void;
}

export const WhyRelatedPanel = ({
  fromVisitId,
  toVisitId,
  toTopicId,
  reasons,
  showOnlyUserAsserted,
  onToggleAssertedOnly,
  onClose,
}: WhyRelatedPanelProps): ReactElement => {
  const visibleReasons = sortReasons(reasons).filter(
    (reason) => !showOnlyUserAsserted || reasonConfidence(reason) === 'asserted',
  );
  return (
    <aside className="cx-why" data-testid="why-related-panel">
      <div className="cx-why-head">
        <div>
          <h4>Why related</h4>
          <p className="cx-mono cx-dim">
            {fromVisitId}
            {toVisitId === undefined ? '' : ` -> ${toVisitId}`}
            {toTopicId === undefined ? '' : ` -> ${toTopicId}`}
          </p>
        </div>
        <button type="button" className="cx-icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <button
        type="button"
        className="cx-why-toggle"
        aria-pressed={showOnlyUserAsserted}
        onClick={onToggleAssertedOnly}
        data-testid="why-related-toggle"
      >
        Show only user-asserted
      </button>
      <ul className="cx-why-list">
        {visibleReasons.map((reason) => (
          <li key={JSON.stringify(reason)} data-testid={`why-reason-${reason.code}`}>
            {renderReason(reason)}
          </li>
        ))}
      </ul>
    </aside>
  );
};
