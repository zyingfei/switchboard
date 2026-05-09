import * as TOML from '@iarna/toml';
import { z } from 'zod';

import { parseSemVer, satisfies as satisfiesRange } from './compatibility.js';

export type ManifestRejectionReason =
  | 'manifest-too-new'
  | 'manifest-too-old'
  | 'requires-companion-not-satisfied'
  | 'requires-vault-not-satisfied'
  | 'no-emits-registered'
  | 'manifest-spawn-policy-unsupported'
  | 'parse-failed'
  | 'schema-failed';

export interface ManifestLoadContext {
  readonly companionFrameworkVersion: string;
  readonly vaultMajor: number;
  readonly minManifestSchema: number;
  readonly maxManifestSchema: number;
  readonly registeredTuples: ReadonlySet<string>;
  readonly maxKnownPayloadVersionFor: (
    collector_id: string,
    event_type: string,
  ) => number | undefined;
}

export type ManifestLoadDecision =
  | { readonly accepted: { readonly manifest: CollectorManifest; readonly warnings: string[] } }
  | { readonly rejected: { readonly reason: ManifestRejectionReason; readonly details?: string } };

export const collectorIdRegex = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

const eventTypeRegex = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const semVerStringSchema = z
  .string()
  .min(1)
  .refine((value) => parseSemVer(value) !== null, 'must be a valid SemVer string');

export const stabilitySchema = z.enum(['alpha', 'beta', 'stable', 'deprecated']);
export const rotationSchema = z.enum(['daily', 'size-1MB', 'size-10MB']);
export const processManagedBySchema = z.enum(['user']);

const compatibilitySchema = z
  .object({
    'requires-companion': z.string().min(1),
    'requires-vault': z.number().int().nonnegative(),
  })
  .strict();

const emitsSchema = z
  .object({
    event_type: z.string().regex(eventTypeRegex),
    payload_version: z.number().int().positive(),
    stability: stabilitySchema.optional(),
  })
  .strict();

const ioSchema = z
  .object({
    rotation: rotationSchema,
  })
  .strict();

const capabilitiesSchema = z
  .object({
    'reads-paths': z.array(z.string()),
    'reads-env': z.array(z.string()),
    'reads-network': z.boolean(),
    'default-enabled': z.boolean(),
  })
  .strict();

const processSchema = z
  .object({
    'managed-by': processManagedBySchema,
    command: z.string().min(1).optional(),
  })
  .strict();

export const collectorManifestSchema = z
  .object({
    id: z.string().regex(collectorIdRegex),
    name: z.string().min(1),
    version: semVerStringSchema,
    stability: stabilitySchema.optional(),
    manifest_schema: z.number().int().positive(),
    compatibility: compatibilitySchema,
    emits: z.array(emitsSchema).nonempty(),
    io: ioSchema,
    capabilities: capabilitiesSchema,
    process: processSchema,
  })
  .strict();

export type CollectorManifest = z.infer<typeof collectorManifestSchema>;

export type ParseManifestResult =
  | { readonly ok: true; readonly manifest: CollectorManifest }
  | { readonly ok: false; readonly reason: string };

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const formatZodError = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');

export const parseManifestTOML = (raw: string): ParseManifestResult => {
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (error) {
    return { ok: false, reason: `parse-failed: ${errorMessage(error)}` };
  }

  const result = collectorManifestSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: `schema-failed: ${formatZodError(result.error)}` };
  }

  return { ok: true, manifest: result.data };
};

const rejected = (
  reason: ManifestRejectionReason,
  details?: string,
): ManifestLoadDecision => {
  if (details === undefined) return { rejected: { reason } };
  return { rejected: { reason, details } };
};

const tupleKey = (collector_id: string, event_type: string, payload_version: number): string =>
  `${collector_id}:${event_type}:${payload_version}`;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const hasGateableCapabilitiesShape = (capabilities: unknown): boolean => {
  if (typeof capabilities !== 'object' || capabilities === null) return false;
  const record = capabilities as Record<string, unknown>;
  return (
    isStringArray(record['reads-paths']) &&
    isStringArray(record['reads-env']) &&
    typeof record['reads-network'] === 'boolean' &&
    typeof record['default-enabled'] === 'boolean'
  );
};

export const decideLoad = (
  manifest: CollectorManifest,
  ctx: ManifestLoadContext,
): ManifestLoadDecision => {
  if (manifest.manifest_schema > ctx.maxManifestSchema) {
    return rejected(
      'manifest-too-new',
      `manifest_schema ${manifest.manifest_schema} is newer than supported maximum ${ctx.maxManifestSchema}`,
    );
  }

  if (manifest.manifest_schema < ctx.minManifestSchema) {
    return rejected(
      'manifest-too-old',
      `manifest_schema ${manifest.manifest_schema} is older than supported minimum ${ctx.minManifestSchema}`,
    );
  }

  const companionRange = manifest.compatibility['requires-companion'];
  if (!satisfiesRange(ctx.companionFrameworkVersion, companionRange)) {
    return rejected(
      'requires-companion-not-satisfied',
      `companion framework ${ctx.companionFrameworkVersion} does not satisfy ${companionRange}`,
    );
  }

  const requiredVaultMajor = manifest.compatibility['requires-vault'];
  if (requiredVaultMajor !== ctx.vaultMajor) {
    return rejected(
      'requires-vault-not-satisfied',
      `vault major ${ctx.vaultMajor} does not match required major ${requiredVaultMajor}`,
    );
  }

  const warnings: string[] = [];
  for (const emitted of manifest.emits) {
    const maxKnownPayloadVersion = ctx.maxKnownPayloadVersionFor(
      manifest.id,
      emitted.event_type,
    );
    if (maxKnownPayloadVersion === undefined) {
      return rejected(
        'no-emits-registered',
        `no materializer is registered for ${manifest.id}:${emitted.event_type}`,
      );
    }

    if (emitted.payload_version > maxKnownPayloadVersion) {
      warnings.push(
        `${manifest.id}:${emitted.event_type}:${emitted.payload_version} is newer than known payload_version ${maxKnownPayloadVersion}; matching lines will be quarantined until the companion upgrades`,
      );
      continue;
    }

    const key = tupleKey(manifest.id, emitted.event_type, emitted.payload_version);
    if (!ctx.registeredTuples.has(key)) {
      return rejected('no-emits-registered', `no materializer is registered for ${key}`);
    }
  }

  const managedBy = manifest.process['managed-by'] as string;
  if (managedBy !== 'user') {
    return rejected(
      'manifest-spawn-policy-unsupported',
      `process.managed-by ${managedBy} is not supported by the MVP loader`,
    );
  }

  if (!hasGateableCapabilitiesShape(manifest.capabilities)) {
    return rejected('schema-failed', 'capabilities block is not gateable');
  }

  return { accepted: { manifest, warnings } };
};
