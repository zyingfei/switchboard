// One-line prototype-lane status text (docs/plans/2026-08-16-category-
// flexibility-hyde.md, UI-visibility phase — "very little visibility
// about how hyDE works"). Shared by every panel surface that shows a
// workstream's prototype standing: the prototype lane's hover/expanded
// row (GuessLanes.tsx) and the workstream picker/detail rows (App.tsx /
// WorkstreamDetailPanel.tsx). ONE formatter so the wording never drifts
// between surfaces.

import type { WorkstreamPrototypeStatus } from '../../companion/categoryFlexibilityClient';
import { formatRelative } from '../../util/time';

/** "3 prototypes · updated 2h ago from 12 pages", or the honest why-not
 *  ("needs 5+ saved pages, has 2" / "Apple Intelligence engine
 *  unavailable" / "generation pending — runs in the background") when
 *  none exist yet. `nowMs` is test-only (deterministic relative time). */
export const prototypeStatusLine = (
  status: WorkstreamPrototypeStatus,
  nowMs?: number,
): string => {
  if (status.whyNot !== null) return status.whyNot;
  const updated =
    status.generatedAt === null
      ? 'recently'
      : formatRelative(new Date(status.generatedAt).toISOString(), {
          short: true,
          ...(nowMs === undefined ? {} : { nowMs }),
        });
  const count = status.prototypeCount;
  return `${String(count)} prototype${count === 1 ? '' : 's'} · updated ${updated} from ${String(status.evidenceCount)} page${status.evidenceCount === 1 ? '' : 's'}`;
};
