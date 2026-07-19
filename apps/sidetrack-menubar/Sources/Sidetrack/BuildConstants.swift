import Foundation

/// Compile-time constants. `build.sh` may regenerate this file to bake
/// the dogfood repo root in as a discovery fallback; by default it is
/// empty and the app relies entirely on runtime discovery
/// (RepoLocator), so the checked-in source is machine-independent.
///
/// Keep this file dependency-free and side-effect-free — build.sh
/// overwrites it wholesale when baking a value.
enum BuildConstants {
    /// Repo root baked at build time, or "" to force runtime discovery.
    static let repoRoot: String = ""
}
