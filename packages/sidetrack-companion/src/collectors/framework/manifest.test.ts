import { describe, expect, it } from 'vitest';
import * as TOML from '@iarna/toml';

import { satisfies } from './compatibility.js';
import {
  decideLoad,
  parseManifestTOML,
  type CollectorManifest,
  type ManifestLoadContext,
  type ManifestLoadDecision,
  type ManifestRejectionReason,
} from './manifest.js';

interface EmitFixture {
  readonly event_type: string;
  readonly payload_version: number;
  readonly stability?: 'alpha' | 'beta' | 'stable' | 'deprecated';
}

interface ManifestFixtureOptions {
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly manifest_schema?: number;
  readonly requiresCompanion?: string;
  readonly requiresVault?: number;
  readonly emits?: readonly EmitFixture[];
  readonly processManagedBy?: string;
  readonly includeName?: boolean;
}

const quoted = (value: string): string => JSON.stringify(value);

const stringArray = (values: readonly string[]): string =>
  `[${values.map((value) => quoted(value)).join(', ')}]`;

const manifestToml = (options: ManifestFixtureOptions = {}): string => {
  const emits = options.emits ?? [
    { event_type: 'tick', payload_version: 1, stability: 'alpha' },
  ];
  const lines: string[] = [
    `id = ${quoted(options.id ?? 'sidetrack.test')}`,
  ];

  if (options.includeName !== false) {
    lines.push(`name = ${quoted(options.name ?? 'Sidetrack Test Collector')}`);
  }

  lines.push(
    `version = ${quoted(options.version ?? '0.1.0')}`,
    'stability = "alpha"',
    `manifest_schema = ${options.manifest_schema ?? 1}`,
    '',
    '[compatibility]',
    `requires-companion = ${quoted(options.requiresCompanion ?? '>=1.7.0 <3.0.0')}`,
    `requires-vault = ${options.requiresVault ?? 1}`,
    '',
  );

  for (const emitted of emits) {
    lines.push(
      '[[emits]]',
      `event_type = ${quoted(emitted.event_type)}`,
      `payload_version = ${emitted.payload_version}`,
    );
    if (emitted.stability !== undefined) {
      lines.push(`stability = ${quoted(emitted.stability)}`);
    }
    lines.push('');
  }

  lines.push(
    '[io]',
    'rotation = "daily"',
    '',
    '[capabilities]',
    `reads-paths = ${stringArray(['~/.sidetrack-test'])}`,
    `reads-env = ${stringArray(['SIDETRACK_TEST_HOME'])}`,
    'reads-network = false',
    'default-enabled = true',
    '',
    '[process]',
    `managed-by = ${quoted(options.processManagedBy ?? 'user')}`,
    '',
  );

  return lines.join('\n');
};

const parseValidManifest = (raw = manifestToml()): CollectorManifest => {
  const result = parseManifestTOML(raw);
  if (!result.ok) throw new Error(result.reason);
  return result.manifest;
};

const context = (overrides: Partial<ManifestLoadContext> = {}): ManifestLoadContext => ({
  companionFrameworkVersion: '1.7.0',
  vaultMajor: 1,
  minManifestSchema: 1,
  maxManifestSchema: 1,
  registeredTuples: new Set<string>(['sidetrack.test:tick:1']),
  maxKnownPayloadVersionFor: (collector_id, event_type) => {
    if (collector_id === 'sidetrack.test' && event_type === 'tick') return 1;
    return undefined;
  },
  ...overrides,
});

const expectRejected = (
  decision: ManifestLoadDecision,
  reason: ManifestRejectionReason,
): void => {
  expect('rejected' in decision).toBe(true);
  if (!('rejected' in decision)) throw new Error('expected manifest rejection');
  expect(decision.rejected.reason).toBe(reason);
};

describe('collector manifest parsing and load decision', () => {
  it('accepts a valid manifest with no warnings', () => {
    const raw = manifestToml();
    expect(TOML.parse(raw)['id']).toBe('sidetrack.test');

    const parsed = parseManifestTOML(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);

    const decision = decideLoad(parsed.manifest, context());
    expect('accepted' in decision).toBe(true);
    if (!('accepted' in decision)) throw new Error('expected manifest acceptance');
    expect(decision.accepted.manifest.id).toBe('sidetrack.test');
    expect(decision.accepted.warnings).toEqual([]);
  });

  it('covers parse-failed', () => {
    const result = parseManifestTOML('id = "unterminated');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected parse failure');
    expect(result.reason.startsWith('parse-failed:')).toBe(true);
  });

  it('covers schema-failed', () => {
    const result = parseManifestTOML(manifestToml({ includeName: false }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected schema failure');
    expect(result.reason.startsWith('schema-failed:')).toBe(true);
  });

  it('covers manifest-too-new', () => {
    const manifest = parseValidManifest(manifestToml({ manifest_schema: 2 }));
    expectRejected(decideLoad(manifest, context()), 'manifest-too-new');
  });

  it('covers manifest-too-old', () => {
    const manifest = parseValidManifest();
    expectRejected(
      decideLoad(manifest, context({ minManifestSchema: 2, maxManifestSchema: 3 })),
      'manifest-too-old',
    );
  });

  it('covers Compass 2.G #5 requires-companion-not-satisfied', () => {
    const manifest = parseValidManifest(
      manifestToml({ requiresCompanion: '>=999.0.0' }),
    );
    expectRejected(decideLoad(manifest, context()), 'requires-companion-not-satisfied');
  });

  it('covers requires-vault-not-satisfied', () => {
    const manifest = parseValidManifest(manifestToml({ requiresVault: 2 }));
    expectRejected(decideLoad(manifest, context()), 'requires-vault-not-satisfied');
  });

  it('covers no-emits-registered when no materializer exists for the event type', () => {
    const manifest = parseValidManifest(
      manifestToml({ emits: [{ event_type: 'unknown_event', payload_version: 1 }] }),
    );
    expectRejected(decideLoad(manifest, context()), 'no-emits-registered');
  });

  it('covers manifest-spawn-policy-unsupported defensively', () => {
    const manifest = {
      ...parseValidManifest(),
      process: { 'managed-by': 'companion' },
    } as unknown as CollectorManifest;

    expectRejected(decideLoad(manifest, context()), 'manifest-spawn-policy-unsupported');
  });

  it('warns rather than rejects when payload_version is ahead of the companion', () => {
    const manifest = parseValidManifest(
      manifestToml({ emits: [{ event_type: 'tick', payload_version: 2 }] }),
    );
    const decision = decideLoad(
      manifest,
      context({
        registeredTuples: new Set<string>(['sidetrack.test:tick:1']),
        maxKnownPayloadVersionFor: (collector_id, event_type) => {
          if (collector_id === 'sidetrack.test' && event_type === 'tick') return 1;
          return undefined;
        },
      }),
    );

    expect('accepted' in decision).toBe(true);
    if (!('accepted' in decision)) throw new Error('expected manifest acceptance');
    expect(decision.accepted.warnings).toHaveLength(1);
    expect(decision.accepted.warnings[0]).toContain('will be quarantined');
  });

  it('rejects when a non-ahead tuple is missing from the exact registry set', () => {
    const manifest = parseValidManifest();
    expectRejected(
      decideLoad(
        manifest,
        context({
          registeredTuples: new Set<string>(),
          maxKnownPayloadVersionFor: (collector_id, event_type) => {
            if (collector_id === 'sidetrack.test' && event_type === 'tick') return 1;
            return undefined;
          },
        }),
      ),
      'no-emits-registered',
    );
  });

  it('satisfies npm-style AND ranges', () => {
    expect(satisfies('1.7.0', '>=1.7.0 <3.0.0')).toBe(true);
    expect(satisfies('1.6.9', '>=1.7.0 <3.0.0')).toBe(false);
    expect(satisfies('2.4.0', '>=1.7.0 <3.0.0')).toBe(true);
    expect(satisfies('3.0.0', '>=1.7.0 <3.0.0')).toBe(false);
    expect(satisfies('999.0.0', '>=1.7.0 <3.0.0')).toBe(false);
  });
});
