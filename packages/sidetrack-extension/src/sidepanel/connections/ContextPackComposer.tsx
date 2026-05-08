import { useState, type ReactElement } from 'react';

import { fetchConnectionsContextPackInput } from './client';
import { buildContextPack, type ContextPackInput } from './contextPack';

export interface ContextPackComposerProps {
  readonly workstreamId: string;
  readonly onClose: () => void;
  readonly loadInput?: (workstreamId: string) => Promise<ContextPackInput>;
}

export const ContextPackComposer = ({
  workstreamId,
  onClose,
  loadInput = async (id) => {
    const response = await fetchConnectionsContextPackInput(id);
    if (!response.ok || response.data === undefined) {
      throw new Error(response.error ?? 'context pack unavailable');
    }
    return response.data;
  },
}: ContextPackComposerProps): ReactElement => {
  const [markdown, setMarkdown] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const compose = (): void => {
    setError(null);
    void loadInput(workstreamId)
      .then((input) => setMarkdown(buildContextPack(input)))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const copy = (): void => {
    void navigator.clipboard.writeText(markdown);
  };

  return (
    <section className="cx-context-pack" data-testid="context-pack-composer">
      <div className="cx-why-head">
        <div>
          <h4>Context Pack</h4>
          <p className="cx-mono cx-dim">{workstreamId}</p>
        </div>
        <button type="button" className="cx-icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <button type="button" className="cx-primary-action" onClick={compose}>
        Compose Context Pack
      </button>
      {error === null ? null : (
        <p className="cx-context-error" role="alert">
          {error}
        </p>
      )}
      {markdown.length > 0 ? (
        <>
          <textarea className="cx-context-output" readOnly value={markdown} />
          <button
            type="button"
            className="cx-primary-action"
            onClick={copy}
            data-testid="context-pack-copy"
          >
            Copy to clipboard
          </button>
        </>
      ) : null}
    </section>
  );
};
