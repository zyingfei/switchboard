export interface ContextPackTopic {
  readonly id: string;
  readonly label: string;
  readonly cohesion: number;
  readonly memberCount: number;
}

export interface ContextPackThread {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
}

export interface ContextPackDispatch {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
}

export interface ContextPackSnippet {
  readonly id: string;
  readonly rawTextStored: boolean;
  readonly text?: string;
  readonly hash?: string;
}

export interface ContextPackIndexedPage {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly coverageState: string;
  readonly quality?: string;
}

export interface ContextPackUserNote {
  readonly id: string;
  readonly text: string;
  readonly authoredBy: 'user' | 'assistant' | 'system';
}

export interface ContextPackInput {
  readonly topic?: ContextPackTopic;
  readonly threads: readonly ContextPackThread[];
  readonly dispatches: readonly ContextPackDispatch[];
  readonly snippets: readonly ContextPackSnippet[];
  readonly indexedPages?: readonly ContextPackIndexedPage[];
  readonly userNotes: readonly ContextPackUserNote[];
}

const cleanLine = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const truncate = (value: string, length: number): string => {
  const normalized = cleanLine(value);
  return normalized.length <= length ? normalized : `${normalized.slice(0, length)}...`;
};

const section = (title: string, lines: readonly string[]): string =>
  [`## ${title}`, ...lines].join('\n');

export const extractOpenQuestions = (notes: readonly ContextPackUserNote[]): readonly string[] => {
  const questions: string[] = [];
  for (const note of notes) {
    if (note.authoredBy !== 'user') continue;
    for (const line of note.text.split(/\r?\n/u)) {
      const text = line.trim();
      if (text.length < 8 || text.length > 200) continue;
      if (/.*\?\s*$/u.test(text)) questions.push(text);
    }
  }
  return questions.sort();
};

export const buildContextPack = (input: ContextPackInput): string => {
  const sections: string[] = [];
  if (input.topic !== undefined) {
    sections.push(
      section('Topic', [
        `- ${input.topic.label}`,
        `- cohesion=${input.topic.cohesion.toFixed(2)}`,
        `- members=${String(input.topic.memberCount)}`,
      ]),
    );
  }

  if (input.threads.length > 0) {
    sections.push(
      section(
        'Threads',
        [...input.threads]
          .sort(
            (left, right) =>
              left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
          )
          .map(
            (thread) => `- ${thread.title}${thread.url === undefined ? '' : ` (${thread.url})`}`,
          ),
      ),
    );
  }

  if (input.dispatches.length > 0) {
    sections.push(
      section(
        'Dispatches',
        [...input.dispatches]
          .sort(
            (left, right) =>
              left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
          )
          .map(
            (dispatch) =>
              `- ${dispatch.title}${dispatch.status === undefined ? '' : ` [${dispatch.status}]`}`,
          ),
      ),
    );
  }

  if (input.snippets.length > 0) {
    sections.push(
      section(
        'Snippets',
        [...input.snippets]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((snippet) => {
            const body = snippet.rawTextStored ? truncate(snippet.text ?? '', 80) : '(hashed)';
            return `- ${snippet.id}: ${body}${
              snippet.hash === undefined ? '' : ` #${snippet.hash}`
            }`;
          }),
      ),
    );
  }

  const indexedPages = input.indexedPages ?? [];
  if (indexedPages.length > 0) {
    sections.push(
      section(
        'Indexed Pages',
        [...indexedPages]
          .sort(
            (left, right) =>
              left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
          )
          .map((page) => {
            const suffix =
              page.quality === undefined
                ? ` [${page.coverageState}]`
                : ` [${page.coverageState}, ${page.quality}]`;
            return `- ${page.title} (${page.url})${suffix}`;
          }),
      ),
    );
  }

  const questions = extractOpenQuestions(input.userNotes);
  if (questions.length > 0) {
    sections.push(
      section(
        'Open Questions',
        questions.map((question) => `- ${question}`),
      ),
    );
  }

  return `${sections.join('\n\n')}\n`;
};
