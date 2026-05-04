import { Fragment, type ReactNode } from 'react';

// Tiny inline renderer for captured-turn text. Replaces markdown image
// references (![alt](url)) and bare <img> tags with rendered <img>
// elements; everything else stays plain text. NOT a full markdown
// renderer — adding one means a new dep + XSS surface analysis.
//
// URL safety: only allow http(s) and data:image/*. Anything else
// renders as the original markdown text. React auto-escapes the URL
// when set on src, so injection of attributes/JS isn't possible
// through src alone.

const MD_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/g;
const HTML_IMG_RE = /<img\s+[^>]*src="(https?:\/\/[^"]+|data:image\/[^"]+)"[^>]*>/g;

interface Token {
  readonly kind: 'text' | 'image';
  readonly value: string;
  readonly alt?: string;
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly token: Token;
}

const tokenize = (input: string): readonly Token[] => {
  // Combine matches from both regexes, sorted by position.
  const matches: Match[] = [];
  for (const m of input.matchAll(MD_IMAGE_RE)) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      token: { kind: 'image', value: m[2], alt: m[1] },
    });
  }
  for (const m of input.matchAll(HTML_IMG_RE)) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      token: { kind: 'image', value: m[1], alt: '' },
    });
  }
  matches.sort((a, b) => a.start - b.start);
  // Drop overlapping matches (md vs html on the same span — rare).
  const filtered: Match[] = [];
  for (const m of matches) {
    if (filtered.length === 0 || m.start >= filtered[filtered.length - 1].end) {
      filtered.push(m);
    }
  }
  if (filtered.length === 0) {
    return [{ kind: 'text', value: input }];
  }
  const out: Token[] = [];
  let cursor = 0;
  for (const m of filtered) {
    if (m.start > cursor) {
      out.push({ kind: 'text', value: input.slice(cursor, m.start) });
    }
    out.push(m.token);
    cursor = m.end;
  }
  if (cursor < input.length) {
    out.push({ kind: 'text', value: input.slice(cursor) });
  }
  return out;
};

interface TurnTextProps {
  readonly text: string;
  // Inline turns are densely packed; keep the truncation behavior the
  // existing renderer used. Pass undefined to disable.
  readonly maxChars?: number;
}

const truncate = (text: string, maxChars: number | undefined): string => {
  if (maxChars === undefined || text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim() + '…';
};

export function TurnText({ text, maxChars = 200 }: TurnTextProps) {
  const tokens = tokenize(text);
  const hasImage = tokens.some((t) => t.kind === 'image');
  // If there are no images, keep the original truncation behavior.
  if (!hasImage) {
    return <>{truncate(text, maxChars)}</>;
  }
  // With images, don't truncate — images are content, not chrome,
  // and chopping mid-image breaks the layout.
  const nodes: ReactNode[] = [];
  let i = 0;
  for (const token of tokens) {
    if (token.kind === 'text') {
      // Truncate just the surrounding prose if it's egregiously long.
      const trimmed = token.value.trim();
      if (trimmed.length === 0) {
        i += 1;
        continue;
      }
      nodes.push(<Fragment key={i}>{trimmed.length > 280 ? trimmed.slice(0, 280) + '…' : trimmed}</Fragment>);
    } else {
      nodes.push(
        <img
          key={i}
          src={token.value}
          alt={token.alt ?? ''}
          className="thread-turn-image"
          loading="lazy"
        />,
      );
    }
    i += 1;
  }
  return <>{nodes}</>;
}
