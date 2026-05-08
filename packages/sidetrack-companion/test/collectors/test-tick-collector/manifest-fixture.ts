// Stage 4 — test-tick collector manifest fixture.
//
// Generates the collector.toml content used by spine.e2e.ts. Kept
// small + literal so each test can mutate one field (e.g. flip
// requires-companion to ">=999.0.0" for compass §2.G test #5).

export interface TestTickManifestOpts {
  readonly id?: string; // default 'sidetrack.test-tick'
  readonly version?: string; // default '0.1.0'
  readonly manifestSchema?: number; // default 1
  readonly requiresCompanion?: string; // default '>=1.0.0 <2.0.0'
  readonly requiresVault?: string; // default '>=1'
  readonly emits?: ReadonlyArray<{
    readonly event_type: string;
    readonly payload_version: number;
    readonly stability?: 'alpha' | 'beta' | 'stable' | 'deprecated';
  }>;
  readonly readsPaths?: readonly string[];
  readonly readsEnv?: readonly string[];
  readonly readsNetwork?: boolean;
  readonly defaultEnabled?: boolean;
  readonly managedBy?: 'user' | string; // anything else → spawn-policy-unsupported
}

export const renderTestTickManifest = (opts: TestTickManifestOpts = {}): string => {
  const id = opts.id ?? 'sidetrack.test-tick';
  const version = opts.version ?? '0.1.0';
  const manifestSchema = opts.manifestSchema ?? 1;
  const requiresCompanion = opts.requiresCompanion ?? '>=1.0.0 <2.0.0';
  const requiresVault = opts.requiresVault ?? '>=1';
  const emits = opts.emits ?? [{ event_type: 'tick', payload_version: 1, stability: 'beta' }];
  const readsPaths = opts.readsPaths ?? [];
  const readsEnv = opts.readsEnv ?? [];
  const readsNetwork = opts.readsNetwork ?? false;
  const defaultEnabled = opts.defaultEnabled ?? true;
  const managedBy = opts.managedBy ?? 'user';

  const tomlArrayOfStrings = (arr: readonly string[]): string =>
    `[${arr.map((s) => JSON.stringify(s)).join(', ')}]`;

  const emitBlocks = emits
    .map(
      (e) =>
        `[[emits]]\nevent_type = ${JSON.stringify(e.event_type)}\npayload_version = ${e.payload_version}\nstability = ${JSON.stringify(e.stability ?? 'stable')}\n`,
    )
    .join('\n');

  return `id          = ${JSON.stringify(id)}
name        = "Test Tick"
version     = ${JSON.stringify(version)}
manifest_schema = ${manifestSchema}

[compatibility]
requires-companion = ${JSON.stringify(requiresCompanion)}
requires-vault     = ${JSON.stringify(requiresVault)}

${emitBlocks}
[io]
output_dir = "_BAC/inbox/${id}/"
rotation = "daily"

[capabilities]
reads-paths     = ${tomlArrayOfStrings(readsPaths)}
reads-env       = ${tomlArrayOfStrings(readsEnv)}
reads-network   = ${readsNetwork ? 'true' : 'false'}
default-enabled = ${defaultEnabled ? 'true' : 'false'}

[process]
managed-by = ${JSON.stringify(managedBy)}
`;
};
