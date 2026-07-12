import { useCallback, useEffect, useState } from 'react';

import { messageTypes } from '../../../src/messages';
import type { NoCaptureRule } from '../../../src/capture/noCaptureRules';

// Settings → Capture → "No-capture sites". Lists the persisted domain
// blocklist rules with (i) remove and (ii) a per-rule "Purge captured
// data" button that invokes the companion domain-tombstone route. Rules
// are created from the toolbar overflow menu ("Don't capture this
// site" / "…similar sites"); this panel is the management surface.

interface RuleActionState {
  readonly ruleId: string;
  readonly kind: 'removing' | 'purging';
}

interface PurgeResultState {
  readonly ruleId: string;
  readonly ok: boolean;
  readonly message: string;
}

const isRuleListResponse = (
  value: unknown,
): value is { ok: true; noCaptureRules: readonly NoCaptureRule[] } =>
  typeof value === 'object' &&
  value !== null &&
  (value as { ok?: unknown }).ok === true &&
  Array.isArray((value as { noCaptureRules?: unknown }).noCaptureRules);

const describeRule = (rule: NoCaptureRule): string => {
  if (rule.kind === 'similar') {
    const tokens = rule.categoryTokens.length > 0 ? ` · ${rule.categoryTokens.join(', ')}` : '';
    return `similar to ${rule.domain}${tokens}`;
  }
  return `${rule.domain} + subdomains`;
};

export function NoCaptureRulesSection({ busy = false }: { readonly busy?: boolean }) {
  const [rules, setRules] = useState<readonly NoCaptureRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [action, setAction] = useState<RuleActionState | null>(null);
  const [purgeResult, setPurgeResult] = useState<PurgeResultState | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        type: messageTypes.listNoCaptureRules,
      });
      if (isRuleListResponse(response)) setRules(response.noCaptureRules);
    } catch {
      // Leave the list as-is; the panel is best-effort.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removeRule = (ruleId: string): void => {
    setAction({ ruleId, kind: 'removing' });
    void (async () => {
      try {
        const response: unknown = await chrome.runtime.sendMessage({
          type: messageTypes.removeNoCaptureRule,
          ruleId,
        });
        if (isRuleListResponse(response)) setRules(response.noCaptureRules);
        else await refresh();
      } catch {
        await refresh();
      } finally {
        setAction(null);
      }
    })();
  };

  const purgeRule = (ruleId: string): void => {
    setAction({ ruleId, kind: 'purging' });
    setPurgeResult(null);
    void (async () => {
      try {
        const response: unknown = await chrome.runtime.sendMessage({
          type: messageTypes.purgeNoCaptureRule,
          ruleId,
        });
        const ok =
          typeof response === 'object' &&
          response !== null &&
          (response as { ok?: unknown }).ok === true;
        setPurgeResult({
          ruleId,
          ok,
          message: ok
            ? 'Purged — captured data for this site is now hidden.'
            : `Purge failed${
                typeof response === 'object' &&
                response !== null &&
                typeof (response as { error?: unknown }).error === 'string'
                  ? `: ${(response as { error: string }).error}`
                  : ' (companion unreachable?)'
              }`,
        });
      } catch (error) {
        setPurgeResult({
          ruleId,
          ok: false,
          message: `Purge failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        setAction(null);
      }
    })();
  };

  return (
    <div className="settings-subsection" id="no-capture-rules" data-testid="no-capture-rules">
      <h4 className="settings-subsection-title">No-capture sites</h4>
      <p className="settings-section-lede">
        Sites here are never captured — no visits, page text, evidence, engagement, or fingerprints.
        Add rules from the toolbar &ldquo;&hellip;&rdquo; menu on the current tab.
      </p>
      {loaded && rules.length === 0 ? (
        <p className="settings-empty mono">No no-capture rules yet.</p>
      ) : (
        <ul className="no-capture-rule-list">
          {rules.map((rule) => (
            <li key={rule.id} className="no-capture-rule-row" data-testid="no-capture-rule-row">
              <span className="no-capture-rule-label">
                <strong>{rule.label}</strong>
                <span className="desc mono">{describeRule(rule)}</span>
                {purgeResult !== null && purgeResult.ruleId === rule.id ? (
                  <span className={'desc ' + (purgeResult.ok ? 'ok' : 'warn')}>
                    {purgeResult.message}
                  </span>
                ) : null}
              </span>
              <span className="no-capture-rule-actions">
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  disabled={busy || action !== null}
                  onClick={() => {
                    purgeRule(rule.id);
                  }}
                  data-testid="purge-captured-data"
                  title="Delete already-captured data for this site (tombstone + hide)"
                >
                  {action?.ruleId === rule.id && action.kind === 'purging'
                    ? 'Purging…'
                    : 'Purge captured data'}
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  disabled={busy || action !== null}
                  onClick={() => {
                    removeRule(rule.id);
                  }}
                  data-testid="remove-no-capture-rule"
                  title="Remove this rule (re-enable capture for this site)"
                >
                  {action?.ruleId === rule.id && action.kind === 'removing' ? 'Removing…' : 'Remove'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
