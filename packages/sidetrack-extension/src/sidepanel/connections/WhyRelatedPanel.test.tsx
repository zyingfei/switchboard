import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import reasonsFixture from './__fixtures__/reasons-all.json';
import { WhyRelatedPanel } from './WhyRelatedPanel';
import type { Reason } from './why-related/reasons';

const reasons = reasonsFixture as readonly (Reason & { readonly expected: string })[];

describe('WhyRelatedPanel', () => {
  it('renders all reason kinds', () => {
    render(
      <WhyRelatedPanel
        fromVisitId="visit:a"
        reasons={reasons}
        showOnlyUserAsserted={false}
        onToggleAssertedOnly={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(13);
  });

  it('toggles to user-asserted reasons', () => {
    const onToggle = vi.fn();
    render(
      <WhyRelatedPanel
        fromVisitId="visit:a"
        reasons={reasons}
        showOnlyUserAsserted
        onToggleAssertedOnly={onToggle}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByTestId('why-reason-COSINE_ABOVE_THRESHOLD')).toBeNull();
    fireEvent.click(screen.getByTestId('why-related-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
