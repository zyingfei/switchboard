import Foundation

/// Decoded `/v1/version` payload. The endpoint wraps its fields in a
/// top-level `data` object, so decoding goes through `VersionEnvelope`.
///
/// Every field except `companionVersion` and `pid` is optional: the
/// companion omits vault/code identity in exotic embeddings, and the
/// build-provenance fields (Part A) are present-but-null when dist is
/// un-stamped. Optional here absorbs both "absent" and "null".
struct VersionEnvelope: Decodable {
    let data: VersionData
}

struct VersionData: Decodable {
    let companionVersion: String
    let vaultRoot: String?
    let startedAt: String?
    let codePath: String?
    let pid: Int
    let instanceLabel: String?
    /// Legacy explicit-launch git sha (SIDETRACK_COMPANION_GIT_SHA);
    /// usually absent on a plain `bun dist/cli.js` run.
    let gitSha: String?
    /// Part A — dist build provenance from dist/BUILD_INFO.json. These
    /// answer "which build is this dist", the signal that catches a
    /// stale daemon whose codePath looks current but whose compiled
    /// code is hours old.
    let buildSha: String?
    let buildTime: String?
    let buildBranch: String?

    /// Parsed `startedAt` as a Date, if present and ISO-8601. Used to
    /// derive uptime for the dropdown.
    ///
    /// A fresh formatter is built per parse rather than shared: the
    /// companion emits `startedAt` with millisecond fractions
    /// (`2026-07-17T22:42:21.474Z`), which requires the explicit
    /// `.withFractionalSeconds` option, with a plain fallback. A
    /// per-call formatter sidesteps ISO8601DateFormatter's non-Sendable
    /// shared-state under Swift 6 strict concurrency at trivial cost
    /// (this runs once per ~3s poll).
    var startedAtDate: Date? {
        guard let startedAt else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: startedAt) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: startedAt)
    }
}
