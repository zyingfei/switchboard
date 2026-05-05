// Single source of truth for the companion's published version.
// Imported by both the CLI surface (printed via --version) and the
// runtime (stamped into the recall index header so a model upgrade
// or schema change can trigger an auto-rebuild on the next start).
export const COMPANION_VERSION = '0.0.0';
