import { Icons } from './icons';

// Linked-notes panel — Obsidian deep-links to human-authored notes
// whose frontmatter has `bac_workstream:` matching the current
// workstream. Backed by `bac.list_workstream_notes` (PR #76 Track C).

export interface LinkedNote {
  readonly id: string;
  readonly title: string;
  readonly relativePath: string;
  readonly editedAt: string;
  readonly pinned?: boolean;
  readonly obsidianUrl?: string;
}

interface LinkedNotesProps {
  readonly notes: readonly LinkedNote[];
  readonly onAddLink?: () => void;
}

export function LinkedNotes({ notes, onAddLink }: LinkedNotesProps) {
  return (
    <div className="linked-notes">
      {notes.map((note) => (
        <a
          key={note.id}
          className="ln-row"
          href={note.obsidianUrl ?? '#'}
          onClick={(e) => {
            if (note.obsidianUrl === undefined) {
              e.preventDefault();
            }
          }}
        >
          <span className="ln-icon">{Icons.doc}</span>
          <div className="ln-body">
            <div className="r1">
              <span className="title">{note.title}</span>
              {note.pinned === true ? <span className="pin-tag">pinned</span> : null}
            </div>
            <div className="r2">
              <code>{note.relativePath}</code> · edited {note.editedAt}
            </div>
          </div>
          <span className="ln-ext" title="open in Obsidian">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </span>
        </a>
      ))}
      {onAddLink !== undefined ? (
        <button type="button" className="ln-add" onClick={onAddLink}>
          {Icons.plus} Link a note…
        </button>
      ) : null}
    </div>
  );
}
