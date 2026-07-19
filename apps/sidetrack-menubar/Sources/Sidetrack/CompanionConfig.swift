import Foundation

/// Which companion instance the app targets. The dogfood setup runs two
/// instances that must never collide:
///
///   daily : port 17373, vault ~/.sidetrack-vault
///   test  : port 17374, vault ~/.sidetrack-vault-test
///
/// The default is `.test` — that is the instance the run-test-companion
/// screen recipe manages, and the one this app was built to babysit.
enum CompanionInstance: String, CaseIterable, Identifiable, Codable {
    case test
    case daily

    var id: String { rawValue }

    /// Human label for the screen session name and menus.
    var label: String { rawValue }

    /// Loopback port the companion binds.
    var port: Int {
        switch self {
        case .test: return 17374
        case .daily: return 17373
        }
    }

    /// Vault root, expanded from the user's home directory. The `~`
    /// forms are the dogfood conventions; never hardcode an absolute
    /// home path (the build/test machine and the user's may differ).
    var vaultRoot: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        switch self {
        case .test: return "\(home)/.sidetrack-vault-test"
        case .daily: return "\(home)/.sidetrack-vault"
        }
    }

    var displayName: String {
        switch self {
        case .test: return "Test (17374)"
        case .daily: return "Daily (17373)"
        }
    }
}

/// Editable runtime configuration. Backed by UserDefaults so the chosen
/// instance survives relaunches. Kept intentionally small: the only
/// user-facing knob is which instance to watch; port + vault derive
/// from it. `repoRoot` is discovered (see `RepoLocator`) so the
/// start/restart shell-out can find scripts/run-test-companion.sh.
struct CompanionConfig: Equatable {
    var instance: CompanionInstance

    var port: Int { instance.port }
    var vaultRoot: String { instance.vaultRoot }
    var label: String { instance.label }

    /// Path to the loopback bridge key for this instance's vault. Read
    /// from disk at call time — NEVER hardcode the key. The daemon
    /// writes it here; the app reads it read-only to authenticate its
    /// /v1/version polls.
    var bridgeKeyPath: String {
        "\(vaultRoot)/_BAC/.config/bridge.key"
    }

    /// Base URL for the loopback API. 127.0.0.1 only — the app makes
    /// zero external network calls (local-first ethos).
    var baseURL: URL {
        // Force-unwrap is safe: the literal is a valid URL for any Int
        // port.
        URL(string: "http://127.0.0.1:\(port)")!
    }

    static let defaultsKey = "SidetrackCompanionInstance"

    /// Load the persisted instance, defaulting to `.test`.
    static func load(from defaults: UserDefaults = .standard) -> CompanionConfig {
        let raw = defaults.string(forKey: defaultsKey) ?? ""
        let instance = CompanionInstance(rawValue: raw) ?? .test
        return CompanionConfig(instance: instance)
    }

    /// Persist the chosen instance.
    func save(to defaults: UserDefaults = .standard) {
        defaults.set(instance.rawValue, forKey: CompanionConfig.defaultsKey)
    }
}
