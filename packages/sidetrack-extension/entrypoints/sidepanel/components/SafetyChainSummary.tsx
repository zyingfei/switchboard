import { useState } from 'react';

import { Icons } from './icons';

// Dispatch-confirm progressive disclosure. Replaces the flat list of
// safety-chain checks with a single collapsible summary line that
// expands to the same per-check detail. Reduces visual density of
// the dispatch confirm modal without hiding any information.
//
// When all checks pass: green theme + "all checks ok" summary.
// When any check fails or warns: signal theme + "needs review" with
// the offending pip rendered .bad.

export type CheckStatus = 'ok' | 'warn' | 'bad';

export interface SafetyCheck {
  readonly key: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

interface SafetyChainSummaryProps {
  readonly checks: readonly SafetyCheck[];
  readonly defaultOpen?: boolean;
}

export function SafetyChainSummary({ checks, defaultOpen = false }: SafetyChainSummaryProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasIssue = checks.some((c) => c.status !== 'ok');
  return (
    <div className={'safety-chain ' + (hasIssue ? 'warn' : 'ok')}>
      <button
        type="button"
        className="sc-head"
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        aria-expanded={open}
      >
        <span className="sc-glyph">
          {hasIssue ? Icons.alert : Icons.check}
        </span>
        <span className="sc-title">
          Safety chain ·{' '}
          <b>
            {hasIssue ? 'needs review' : `${String(checks.length)} checks ok`}
          </b>
        </span>
        <div className="sc-list">
          {checks.map((c) => (
            <span
              key={c.key}
              className={'sc-pip' + (c.status === 'bad' ? ' bad' : c.status === 'ok' ? ' ok' : '')}
              title={c.detail}
            >
              {c.label}
            </span>
          ))}
        </div>
        <span className={'sc-chev' + (open ? ' open' : '')}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="sc-detail">
          {checks.map((c) => (
            <div key={c.key} className="sc-row">
              <span className={'sc-pip' + (c.status === 'bad' ? ' bad' : c.status === 'ok' ? ' ok' : '')}>
                {c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗'}
              </span>
              <b>{c.label}</b>
              <span className="muted">{c.detail ?? '—'}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
