import { useState } from 'react';
import { Modal } from './Modal';

export type CodingTool = 'codex' | 'claude_code' | 'cursor' | 'jetbrains' | 'other';

const TOOL_LABEL: Record<CodingTool, string> = {
  codex: 'Codex CLI',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  jetbrains: 'JetBrains',
  other: 'Other',
};

export interface CodingAttachProps {
  readonly defaultWorkstreamId?: string;
  readonly workstreams: readonly { readonly bac_id: string; readonly path: string }[];
  readonly onCancel: () => void;
  readonly onAttach: (input: {
    readonly tool: CodingTool;
    readonly cwd: string;
    readonly branch: string;
    readonly sessionId: string;
    readonly name: string;
    readonly resumeCommand: string;
    readonly workstreamId: string;
  }) => void;
}

export function CodingAttach({
  defaultWorkstreamId,
  workstreams,
  onCancel,
  onAttach,
}: CodingAttachProps) {
  const [tool, setTool] = useState<CodingTool>('claude_code');
  const [cwd, setCwd] = useState('');
  const [branch, setBranch] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [name, setName] = useState('');
  const [resumeCommand, setResumeCommand] = useState('');
  const [workstreamId, setWorkstreamId] = useState(
    defaultWorkstreamId ?? (workstreams.length > 0 ? workstreams[0].bac_id : ''),
  );

  const valid = sessionId.trim() !== '' && name.trim() !== '' && workstreamId !== '';

  const detectResume = () => {
    if (sessionId.trim() === '') {
      return;
    }
    if (tool === 'claude_code') {
      setResumeCommand(`claude resume ${sessionId.trim()}`);
    } else if (tool === 'codex') {
      setResumeCommand(`codex resume ${sessionId.trim()}`);
    } else {
      setResumeCommand('');
    }
  };

  return (
    <Modal
      title="Attach coding session"
      subtitle="Attached sessions appear in the workstream tree alongside chats."
      width={520}
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
            disabled={!valid}
            onClick={() => {
              onAttach({ tool, cwd, branch, sessionId, name, resumeCommand, workstreamId });
            }}
          >
            Attach
          </button>
        </>
      }
    >
      <div className="composer-row">
        <label>Tool</label>
        <div className="pill-row">
          {(Object.keys(TOOL_LABEL) as readonly CodingTool[]).map((t) => (
            <button
              key={t}
              type="button"
              className={'pill ' + (tool === t ? 'on' : '')}
              onClick={() => {
                setTool(t);
              }}
            >
              {TOOL_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="composer-row">
        <label>
          cwd <span className="mono dim">(working directory)</span>
        </label>
        <input
          type="text"
          className="mono"
          value={cwd}
          onChange={(event) => {
            setCwd(event.target.value);
          }}
          placeholder="/Users/you/Documents/repo"
        />
      </div>

      <div className="composer-row">
        <label>
          Branch <span className="mono dim">(optional)</span>
        </label>
        <input
          type="text"
          className="mono"
          value={branch}
          onChange={(event) => {
            setBranch(event.target.value);
          }}
          placeholder="main"
        />
      </div>

      <div className="composer-row">
        <label>Session ID</label>
        <input
          type="text"
          className="mono"
          value={sessionId}
          onChange={(event) => {
            setSessionId(event.target.value);
          }}
          onBlur={detectResume}
          placeholder="019dcb94-4c4c-…"
        />
      </div>

      <div className="composer-row">
        <label>
          Name <span className="mono dim">(human-readable)</span>
        </label>
        <input
          type="text"
          className="ai-italic"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder="MVP PRD iteration"
        />
      </div>

      <div className="composer-row">
        <label>Resume command</label>
        <textarea
          className="mono"
          value={resumeCommand}
          onChange={(event) => {
            setResumeCommand(event.target.value);
          }}
          placeholder="claude resume <session-id>"
          rows={2}
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
