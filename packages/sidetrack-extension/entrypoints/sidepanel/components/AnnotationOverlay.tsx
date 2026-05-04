// Annotation visual overlay — restored highlights + margin markers
// when the user revisits a page they previously annotated. Backed by
// `bac.list_annotations` (PR #76 Track E).
//
// Content-script integration is the parent's responsibility — this
// component renders presentation-only DOM. The parent must:
//   1. On page load, GET /v1/annotations?url=<location>
//   2. Resolve each anchor's Range via the existing anchor finder
//   3. Compute margin-marker positions (top%) from each Range
//   4. Mount this component as the overlay layer

export interface AnnotationMarker {
  readonly id: string;
  readonly topPercent: number;
  readonly count: number;
  readonly tone: 'signal' | 'amber' | 'green';
}

interface AnnotationOverlayProps {
  readonly markers: readonly AnnotationMarker[];
  readonly hint?: { readonly count: number; readonly onOpenPanel: () => void };
  readonly onMarkerClick?: (id: string) => void;
}

export function AnnotationOverlay({
  markers,
  hint,
  onMarkerClick,
}: AnnotationOverlayProps) {
  if (markers.length === 0 && hint === undefined) {
    return null;
  }
  return (
    <div className="ann-overlay" aria-hidden="true">
      {markers.map((m) => (
        <div
          key={m.id}
          className="ann-margin"
          style={{ top: `${String(m.topPercent)}%` }}
          onClick={() => {
            onMarkerClick?.(m.id);
          }}
          role="button"
          title={`${String(m.count)} annotation${m.count === 1 ? '' : 's'} in this region`}
        >
          <span className={`hp-dot ${m.tone}`} />
          <span className="ann-tag">{m.count}</span>
        </div>
      ))}
      {hint !== undefined ? (
        <div className="ann-hint">
          <span className="hp-dot signal" />
          {hint.count} annotation{hint.count === 1 ? '' : 's'} restored on this page
          <button type="button" onClick={hint.onOpenPanel}>
            Open in panel
          </button>
        </div>
      ) : null}
    </div>
  );
}
