import { describe, expect, it } from 'vitest';
import {
  buildArtifactDownloadName,
  buildCaptureDownloadName,
  renderArtifactMarkdown,
  renderCaptureMarkdown,
} from '../../src/capture/export';
import type { ProviderCapture } from '../../src/capture/model';

const sampleCapture: ProviderCapture = {
  id: 'capture-1',
  provider: 'chatgpt',
  url: 'https://chatgpt.com/c/example',
  title: 'Homebrew claude upgrade error',
  capturedAt: '2026-04-25T12:34:56.000Z',
  extractionConfigVersion: '2026-04-25-chatgpt-v2',
  selectorCanary: 'passed',
  turns: [
    {
      id: 'turn-1',
      role: 'assistant',
      text: 'Visible response',
      formattedText: '```bash\nnpm run build\n```',
      ordinal: 0,
      sourceSelector: '[data-message-author-role]',
    },
  ],
  artifacts: [
    {
      id: 'artifact-1',
      kind: 'report',
      title: 'Research report',
      text: 'https://example.com/report',
      formattedText: '## Executive Summary\n\nhttps://example.com/report',
      sourceSelector: 'frame document',
      sourceUrl: 'https://example.com/frame',
      links: [
        {
          id: 'artifact-link-1',
          label: 'Link 1',
          url: 'https://example.com/report',
        },
      ],
    },
  ],
  warnings: [],
  visibleTextCharCount: 16,
};

describe('capture export', () => {
  it('renders a markdown artifact with metadata and formatted turns', () => {
    const markdown = renderCaptureMarkdown(sampleCapture);

    expect(markdown).toContain('# Homebrew claude upgrade error');
    expect(markdown).toContain('- Provider: ChatGPT');
    expect(markdown).toContain('- Extraction config: 2026-04-25-chatgpt-v2');
    expect(markdown).toContain('## ChatGPT 1 - assistant');
    expect(markdown).toContain('```bash');
    expect(markdown).toContain('## Artifact 1 - Research report');
    expect(markdown).toContain('[Link 1](https://example.com/report)');
  });

  it('builds a safe download filename', () => {
    expect(buildCaptureDownloadName(sampleCapture)).toContain('chatgpt-homebrew-claude-upgrade-error-2026-04-25T12-34-56-000Z.md');
  });

  it('renders and names individual artifact exports', () => {
    const artifactMarkdown = renderArtifactMarkdown(sampleCapture, sampleCapture.artifacts[0]);
    expect(artifactMarkdown).toContain('# Research report');
    expect(artifactMarkdown).toContain('## Links');
    expect(buildArtifactDownloadName(sampleCapture, sampleCapture.artifacts[0])).toContain(
      'chatgpt-homebrew-claude-upgrade-error-research-report-2026-04-25T12-34-56-000Z.md',
    );
  });

  it('does not throw when rendering a legacy or partial capture shape', () => {
    const partialCapture = {
      ...sampleCapture,
      artifacts: undefined,
      warnings: undefined,
      capturedAt: undefined,
    } as unknown as ProviderCapture;

    expect(() => renderCaptureMarkdown(partialCapture)).not.toThrow();
    expect(() => buildCaptureDownloadName(partialCapture)).not.toThrow();
    expect(() =>
      renderArtifactMarkdown(partialCapture, {
        ...sampleCapture.artifacts[0],
        links: undefined,
      } as unknown as (typeof sampleCapture.artifacts)[number]),
    ).not.toThrow();
  });
});
