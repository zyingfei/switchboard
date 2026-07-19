import Foundation

/// Finds the browser-ai-companion repo root so start/restart can invoke
/// `scripts/run-test-companion.sh`. The .app bundle lives outside the
/// repo (often /Applications), so the path must be discovered, not
/// assumed.
///
/// Resolution order:
///   1. `codePath` from a running companion's /v1/version — the most
///      reliable anchor when the daemon is up
///      (…/packages/sidetrack-companion/dist/cli.js → 3 levels up).
///   2. A user override persisted in UserDefaults (set via the app if
///      auto-discovery ever fails).
///   3. The build-time repo path baked in at compile time (build.sh
///      passes -DSIDETRACK_REPO_ROOT), valid on the dogfood machine.
///   4. A short list of conventional locations under $HOME.
///
/// Every candidate is validated: the directory must contain
/// `scripts/run-test-companion.sh`. The first that does wins.
enum RepoLocator {
    static let overrideKey = "SidetrackRepoRoot"

    /// The relative script that proves a directory is the repo root.
    private static let anchorScript = "scripts/run-test-companion.sh"

    /// Compile-time repo root, injected by build.sh via a Swift active
    /// compilation define fallback. When unset, this is empty.
    private static var bakedRepoRoot: String {
        // build.sh writes this into a generated file if it wants to; by
        // default we rely on runtime discovery, so this is empty.
        BuildConstants.repoRoot
    }

    /// Best-effort repo root. `codePath` is the running companion's
    /// entry-script path (may be nil when stopped).
    static func resolve(
        codePath: String?,
        defaults: UserDefaults = .standard
    ) -> String? {
        var candidates: [String] = []

        if let codePath, let root = repoRootFromCodePath(codePath) {
            candidates.append(root)
        }
        if let override = defaults.string(forKey: overrideKey), !override.isEmpty {
            candidates.append(override)
        }
        if !bakedRepoRoot.isEmpty {
            candidates.append(bakedRepoRoot)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        candidates.append(contentsOf: [
            "\(home)/playground/playground/browser-ai-companion",
            "\(home)/playground/browser-ai-companion",
            "\(home)/browser-ai-companion",
        ])

        for candidate in candidates where isRepoRoot(candidate) {
            return candidate
        }
        return nil
    }

    /// …/packages/sidetrack-companion/dist/cli.js → repo root is the
    /// grandparent of packages/. Walk up until we find the anchor.
    private static func repoRootFromCodePath(_ codePath: String) -> String? {
        var dir = (codePath as NSString).deletingLastPathComponent
        // Bound the walk so a pathological codePath can't loop forever.
        for _ in 0..<8 {
            if isRepoRoot(dir) { return dir }
            let parent = (dir as NSString).deletingLastPathComponent
            if parent == dir { break }
            dir = parent
        }
        return nil
    }

    private static func isRepoRoot(_ dir: String) -> Bool {
        guard !dir.isEmpty else { return false }
        let anchor = (dir as NSString).appendingPathComponent(anchorScript)
        return FileManager.default.fileExists(atPath: anchor)
    }
}
