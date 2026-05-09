// Single source of truth for the companion's published version.
// Imported by both the CLI surface (printed via --version) and the
// runtime (stamped into the recall index header so a model upgrade
// or schema change can trigger an auto-rebuild on the next start).
export const COMPANION_VERSION = '0.0.0';

// Lock 5 (Stage 4) — collector framework API surface version. Bumps
// independently of COMPANION_VERSION. Manifests' [compatibility].
// requires-companion is a SemVer range over THIS value, not the
// companion's product version. See docs/proposals/stage-4-collector-
// framework.md.
export const COLLECTOR_FRAMEWORK_VERSION = '1.0.0';

// Manifest schema version range supported by this companion. A
// manifest with manifest_schema outside [MIN, MAX] refuses to load
// (audit reason: manifest-too-new / manifest-too-old).
export const MIN_MANIFEST_SCHEMA = 1;
export const MAX_MANIFEST_SCHEMA = 1;
