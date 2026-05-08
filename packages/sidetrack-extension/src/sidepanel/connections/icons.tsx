import type { ReactElement } from 'react';

import type { ConnectionNodeKind } from './types';

// 1.6 stroke single-path icons; one per node kind, plus a few utility
// icons (search, close, warn, copy). Ported from
// switchboard/project/connections-shared.jsx.

const baseProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const KindIcons: Record<ConnectionNodeKind, ReactElement> = {
  thread: (
    <svg {...baseProps}>
      <path d="M21 12a8 8 0 0 1-8 8 8 8 0 0 1-3.5-.8L3 21l1.6-5.6A8 8 0 1 1 21 12z" />
    </svg>
  ),
  workstream: (
    <svg {...baseProps}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  dispatch: (
    <svg {...baseProps}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </svg>
  ),
  'queue-item': (
    <svg {...baseProps}>
      <path d="M3 6h13" />
      <path d="M3 12h13" />
      <path d="M3 18h9" />
      <circle cx="20" cy="18" r="2.5" />
    </svg>
  ),
  'inbound-reminder': (
    <svg {...baseProps}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8z" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  ),
  'coding-session': (
    <svg {...baseProps}>
      <path d="m8 6-6 6 6 6" />
      <path d="m16 6 6 6-6 6" />
    </svg>
  ),
  'timeline-visit': (
    <svg {...baseProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z" />
    </svg>
  ),
  annotation: (
    <svg {...baseProps}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10l6 6v10a2 2 0 0 1-2 2z" />
      <path d="M14 3v6h6" />
      <path d="M7 13h7" />
      <path d="M7 17h5" />
    </svg>
  ),
};

export const SearchIcon = (
  <svg {...baseProps}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const CloseIcon = (
  <svg {...baseProps}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);
