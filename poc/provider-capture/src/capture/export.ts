import type { CapturedArtifact, ProviderCapture } from './model';
import { providerLabels } from './model';

const sanitizeFilename = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'capture';

const turnHeading = (capture: ProviderCapture, ordinal: number): string =>
  `## ${providerLabels[capture.provider]} ${ordinal + 1} - ${capture.turns[ordinal]?.role ?? 'turn'}`;

const artifactHeading = (artifact: CapturedArtifact, ordinal: number): string =>
  `## Artifact ${ordinal + 1} - ${artifact.title}`;

export const renderCaptureMarkdown = (capture: ProviderCapture): string => {
  const metaLines = [
    `# ${capture.title}`,
    '',
    `- Provider: ${providerLabels[capture.provider]}`,
    `- Captured at: ${capture.capturedAt}`,
    `- URL: ${capture.url}`,
    `- Selector canary: ${capture.selectorCanary}`,
    ...(capture.extractionConfigVersion ? [`- Extraction config: ${capture.extractionConfigVersion}`] : []),
    '',
  ];

  const warningLines =
    capture.warnings.length > 0
      ? ['## Warnings', '', ...capture.warnings.map((warning) => `- ${warning.message}`), '']
      : [];

  const turnSections = capture.turns.flatMap((turn, index) => [
    turnHeading(capture, index),
    '',
    turn.formattedText?.trim() || turn.text,
    '',
  ]);

  const artifactSections = capture.artifacts.flatMap((artifact, index) => [
    artifactHeading(artifact, index),
    '',
    `- Kind: ${artifact.kind}`,
    ...(artifact.sourceUrl ? [`- Source URL: ${artifact.sourceUrl}`] : []),
    ...(artifact.links.length > 0 ? ['', '### Links', '', ...artifact.links.map((link) => `- [${link.label}](${link.url})`)] : []),
    '',
    artifact.formattedText.trim() || artifact.text,
    '',
  ]);

  return [...metaLines, ...warningLines, ...turnSections, ...artifactSections].join('\n').trim() + '\n';
};

export const renderArtifactMarkdown = (capture: ProviderCapture, artifact: CapturedArtifact): string => {
  const lines = [
    `# ${artifact.title}`,
    '',
    `- Parent capture: ${capture.title}`,
    `- Provider: ${providerLabels[capture.provider]}`,
    `- Captured at: ${capture.capturedAt}`,
    `- Kind: ${artifact.kind}`,
    ...(artifact.sourceUrl ? [`- Source URL: ${artifact.sourceUrl}`] : []),
    ...(artifact.links.length > 0 ? ['', '## Links', '', ...artifact.links.map((link) => `- [${link.label}](${link.url})`)] : []),
    '',
    artifact.formattedText.trim() || artifact.text,
    '',
  ];

  return lines.join('\n').trim() + '\n';
};

export const buildCaptureDownloadName = (capture: ProviderCapture): string => {
  const stamp = capture.capturedAt.replace(/[:.]/g, '-');
  return `${capture.provider}-${sanitizeFilename(capture.title)}-${stamp}.md`;
};

export const buildArtifactDownloadName = (capture: ProviderCapture, artifact: CapturedArtifact): string => {
  const stamp = capture.capturedAt.replace(/[:.]/g, '-');
  return `${capture.provider}-${sanitizeFilename(capture.title)}-${sanitizeFilename(artifact.title)}-${stamp}.md`;
};
