import { useState } from 'react';
import { Modal } from './Modal';

export interface AnnotationProps {
  readonly selection: string;
  readonly url: string;
  readonly pageTitle: string;
  readonly workstreams: readonly { readonly bac_id: string; readonly path: string }[];
  readonly defaultWorkstreamId?: string;
  readonly onCancel: () => void;
  readonly onSave: (input: { readonly note: string; readonly workstreamId: string }) => void;
}

export function Annotation({
  selection,
  url,
  pageTitle,
  workstreams,
  defaultWorkstreamId,
  onCancel,
  onSave,
}: AnnotationProps) {
  const initialWorkstream =
    defaultWorkstreamId ?? (workstreams.length > 0 ? workstreams[0].bac_id : '');
  const [note, setNote] = useState('');
  const [workstreamId, setWorkstreamId] = useState(initialWorkstream);

  return (
    <Modal
      title="Save to Sidetrack"
      subtitle={pageTitle}
      width={460}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <div className="spacer" />
          <button
            type="button"
            className="btn btn-primary"
            disabled={workstreamId === ''}
            onClick={() => {
              onSave({ note, workstreamId });
            }}
          >
            Save
          </button>
        </>
      }
    >
      <blockquote className="annotation-selection">{selection}</blockquote>
      <div className="annotation-meta mono">{url}</div>

      <div className="composer-row">
        <label>Note</label>
        <textarea
          autoFocus
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          placeholder="Why are you saving this?"
          rows={3}
        />
      </div>

      <div className="composer-row">
        <label>Workstream</label>
        <select
          value={workstreamId}
          onChange={(event) => {
            setWorkstreamId(event.target.value);
          }}
        >
          <option value="">— pick a workstream —</option>
          {workstreams.map((workstream) => (
            <option key={workstream.bac_id} value={workstream.bac_id}>
              {workstream.path}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}
