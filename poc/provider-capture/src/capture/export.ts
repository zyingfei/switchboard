import type { CapturedArtifact, ProviderCapture } from './model';
import { providerLabels } from './model';

const sanitizeFilename = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'capture';

const turnHeading = (capture: ProviderCapture, ordinal: number): string =>
  `## ${providerLabels[capture.provider]} ${ordinal + 1} - ${(capture.turns ?? [])[ordinal]?.role ?? 'turn'}`;

const artifactHeading = (artifact: CapturedArtifact, ordinal: number): string =>
  `## Artifact ${ordinal + 1} - ${artifact.title}`;

export const renderCaptureMarkdown = (capture: ProviderCapture): string => {
  const warnings = Array.isArray(capture.warnings) ? capture.warnings : [];
  const turns = Array.isArray(capture.turns) ? capture.turns : [];
  const artifacts = Array.isArray(capture.artifacts) ? capture.artifacts : [];
  const metaLines = [
    `# ${capture.title ?? 'Untitled capture'}`,
    '',
    `- Provider: ${providerLabels[capture.provider]}`,
    `- Captured at: ${capture.capturedAt ?? new Date(0).toISOString()}`,
    `- URL: ${capture.url ?? ''}`,
    `- Selector canary: ${capture.selectorCanary ?? 'failed'}`,
    ...(capture.extractionConfigVersion ? [`- Extraction config: ${capture.extractionConfigVersion}`] : []),
    '',
  ];

  const warningLines =
    warnings.length > 0
      ? ['## Warnings', '', ...warnings.map((warning) => `- ${warning.message}`), '']
      : [];

  const turnSections = turns.flatMap((turn, index) => [
    turnHeading(capture, index),
    '',
    turn.formattedText?.trim() || turn.text,
    '',
  ]);

  const artifactSections = artifacts.flatMap((artifact, index) => {
    const links = Array.isArray(artifact.links) ? artifact.links : [];
    return [
      artifactHeading(artifact, index),
      '',
      `- Kind: ${artifact.kind}`,
      ...(artifact.sourceUrl ? [`- Source URL: ${artifact.sourceUrl}`] : []),
      ...(links.length > 0 ? ['', '### Links', '', ...links.map((link) => `- [${link.label}](${link.url})`)] : []),
      '',
      artifact.formattedText?.trim() || artifact.text,
      '',
    ];
  });

  return [...metaLines, ...warningLines, ...turnSections, ...artifactSections].join('\n').trim() + '\n';
};

export const renderArtifactMarkdown = (capture: ProviderCapture, artifact: CapturedArtifact): string => {
  const links = Array.isArray(artifact.links) ? artifact.links : [];
  const lines = [
    `# ${artifact.title ?? 'Captured artifact'}`,
    '',
    `- Parent capture: ${capture.title ?? 'Untitled capture'}`,
    `- Provider: ${providerLabels[capture.provider]}`,
    `- Captured at: ${capture.capturedAt ?? new Date(0).toISOString()}`,
    `- Kind: ${artifact.kind ?? 'unknown'}`,
    ...(artifact.sourceUrl ? [`- Source URL: ${artifact.sourceUrl}`] : []),
    ...(links.length > 0 ? ['', '## Links', '', ...links.map((link) => `- [${link.label}](${link.url})`)] : []),
    '',
    artifact.formattedText?.trim() || artifact.text,
    '',
  ];

  return lines.join('\n').trim() + '\n';
};

export const buildCaptureDownloadName = (capture: ProviderCapture): string => {
  const stamp = (capture.capturedAt ?? new Date(0).toISOString()).replace(/[:.]/g, '-');
  return `${capture.provider}-${sanitizeFilename(capture.title ?? 'capture')}-${stamp}.md`;
};

export const buildArtifactDownloadName = (capture: ProviderCapture, artifact: CapturedArtifact): string => {
  const stamp = (capture.capturedAt ?? new Date(0).toISOString()).replace(/[:.]/g, '-');
  return `${capture.provider}-${sanitizeFilename(capture.title ?? 'capture')}-${sanitizeFilename(artifact.title ?? 'artifact')}-${stamp}.md`;
};
