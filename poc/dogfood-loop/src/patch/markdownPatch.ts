export type PatchMode = 'useA' | 'useB' | 'appendBoth';

export interface BranchArtifact {
  provider: string;
  title: string;
  content: string;
}

export interface MarkdownPatchPreview {
  mode: PatchMode;
  original: string;
  proposed: string;
}

const normalizeMarkdown = (value: string): string => value.replace(/\s+$/u, '');

const byProvider = (left: BranchArtifact, right: BranchArtifact): number =>
  left.provider.localeCompare(right.provider);

export const selectPatchBranches = (
  branches: BranchArtifact[],
  mode: PatchMode,
): BranchArtifact[] => {
  const sorted = [...branches].sort(byProvider);
  if (mode === 'useA') {
    return sorted.filter((branch) => branch.provider === 'mock-chat-a').slice(0, 1);
  }
  if (mode === 'useB') {
    return sorted.filter((branch) => branch.provider === 'mock-chat-b').slice(0, 1);
  }
  return sorted;
};

export const buildUpdatedMarkdown = (
  original: string,
  branches: BranchArtifact[],
  mode: PatchMode,
): string => {
  const selected = selectPatchBranches(branches, mode);
  const body = selected
    .map((branch) => `### ${branch.title}\n\n${normalizeMarkdown(branch.content)}`)
    .join('\n\n');
  const suffix = body.length > 0 ? `\n\n## Converged Responses\n\n${body}` : '';
  return `${normalizeMarkdown(original)}${suffix}\n`;
};

export const buildMarkdownPatchPreview = (
  original: string,
  branches: BranchArtifact[],
  mode: PatchMode,
): MarkdownPatchPreview => ({
  mode,
  original,
  proposed: buildUpdatedMarkdown(original, branches, mode),
});
