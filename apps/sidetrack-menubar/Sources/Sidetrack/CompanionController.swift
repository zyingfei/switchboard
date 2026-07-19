import AppKit
import Foundation
import SwiftUI

/// Result of a managed shell-out. Top-level + Sendable so the
/// nonisolated `runShell` helper can return it across the actor
/// boundary from a detached task.
private enum ShellResult: Sendable {
    case success
    case failure(String)
}

/// High-level status the menu bar renders.
enum CompanionStatus: Equatable {
    case running
    case stopped
    case unreachable
    case error(String)
    /// Before the first poll completes.
    case unknown

    var glyphName: String {
        switch self {
        case .running: return "circle.fill"
        case .stopped: return "circle"
        case .unreachable: return "exclamationmark.circle"
        case .error: return "xmark.circle"
        case .unknown: return "circle.dotted"
        }
    }

    var tint: Color {
        switch self {
        case .running: return .green
        case .stopped: return .gray
        case .unreachable: return .orange
        case .error: return .red
        case .unknown: return .secondary
        }
    }

    var barLabel: String {
        switch self {
        case .running: return "up"
        case .stopped: return "down"
        case .unreachable: return "busy"
        case .error: return "err"
        case .unknown: return "…"
        }
    }

    var title: String {
        switch self {
        case .running: return "Running"
        case .stopped: return "Stopped"
        case .unreachable: return "Unreachable (busy?)"
        case .error(let m): return "Error — \(m)"
        case .unknown: return "Checking…"
        }
    }
}

/// The app's single source of truth. Owns the poll loop, the last
/// decoded version data, and the shell-out actions. Runs on the main
/// actor; every blocking operation (URLSession, Process) is awaited off
/// the main thread so the UI never stalls on a slow daemon.
@MainActor
final class CompanionController: ObservableObject {
    @Published private(set) var status: CompanionStatus = .unknown
    @Published private(set) var version: VersionData?
    @Published private(set) var lastPolledAt: Date?
    @Published private(set) var lastActionMessage: String?
    @Published var config: CompanionConfig {
        didSet {
            guard config != oldValue else { return }
            config.save()
            // Reset state immediately so the UI doesn't show stale data
            // from the previous instance while the first new poll runs.
            version = nil
            status = .unknown
            Task { await pollOnce() }
        }
    }

    /// ~3s cadence per the spec. A poll never overlaps itself: the loop
    /// awaits each probe before sleeping.
    private let pollInterval: Duration = .seconds(3)
    private var pollTask: Task<Void, Never>?

    init(config: CompanionConfig = .load()) {
        self.config = config
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollOnce()
                try? await Task.sleep(for: self?.pollInterval ?? .seconds(3))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Run one probe and fold the result into published state.
    func pollOnce() async {
        let client = CompanionClient(config: config)
        let result = await client.probe()
        lastPolledAt = Date()
        switch result {
        case .running(let data):
            version = data
            status = .running
        case .stopped:
            version = nil
            status = .stopped
        case .unreachable:
            // Keep the last known version visible while busy — it is
            // still the build that is (slowly) running.
            status = .unreachable
        case .error(let message):
            status = .error(message)
        }
    }

    // MARK: - Derived display

    var uptimeDescription: String? {
        guard let started = version?.startedAtDate else { return nil }
        let seconds = Date().timeIntervalSince(started)
        guard seconds >= 0 else { return nil }
        return Self.formatDuration(seconds)
    }

    static func formatDuration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds)
        let d = total / 86400
        let h = (total % 86400) / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if d > 0 { return "\(d)d \(h)h \(m)m" }
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m \(s)s" }
        return "\(s)s"
    }

    // MARK: - Actions

    /// Reveal the vault root in Finder.
    func openVault() {
        let path = config.vaultRoot
        guard FileManager.default.fileExists(atPath: path) else {
            lastActionMessage = "Vault not found: \(path)"
            return
        }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }

    /// Start the companion via the proven screen recipe. No-op-safe if
    /// already running (screen -dmS with a taken session name just
    /// fails harmlessly; we key the session by label).
    func startCompanion() {
        runManaged(steps: [startScreenCommand()], actionName: "Start")
    }

    /// Stop: quit the screen session and hard-kill the daemon on this
    /// instance's port. kill -9 is safe here — the companion's
    /// recovery.ts handles an abrupt exit.
    func stopCompanion() {
        runManaged(
            steps: [quitScreenCommand(), pkillCommand()],
            actionName: "Stop")
    }

    /// Restart = the full recipe: quit screen + pkill + relaunch. This
    /// is the hand-rolled recipe the user runs today, parameterised by
    /// label/port.
    func restartCompanion() {
        runManaged(
            steps: [
                quitScreenCommand(), pkillCommand(), startScreenCommand(),
            ],
            actionName: "Restart")
    }

    /// A copy-pasteable diagnostics blob for bug reports / eyeballing.
    func diagnosticsText() -> String {
        var lines: [String] = []
        lines.append("Sidetrack companion diagnostics")
        lines.append("instance: \(config.label)  port: \(config.port)")
        lines.append("vaultRoot: \(config.vaultRoot)")
        lines.append("status: \(status.title)")
        if let v = version {
            lines.append("companionVersion: \(v.companionVersion)")
            lines.append("buildSha: \(v.buildSha ?? "—")")
            lines.append("buildBranch: \(v.buildBranch ?? "—")")
            lines.append("buildTime: \(v.buildTime ?? "—")")
            lines.append("gitSha: \(v.gitSha ?? "—")")
            lines.append("pid: \(v.pid)")
            lines.append("instanceLabel: \(v.instanceLabel ?? "—")")
            lines.append("codePath: \(v.codePath ?? "—")")
            lines.append("startedAt: \(v.startedAt ?? "—")")
            if let up = uptimeDescription { lines.append("uptime: \(up)") }
        } else {
            lines.append("(no version payload — companion not answering)")
        }
        if let polled = lastPolledAt {
            lines.append("lastPolledAt: \(ISO8601DateFormatter().string(from: polled))")
        }
        return lines.joined(separator: "\n")
    }

    func copyDiagnostics() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(diagnosticsText(), forType: .string)
        lastActionMessage = "Diagnostics copied"
    }

    // MARK: - Shell-out plumbing

    private func screenSessionName() -> String {
        "sidetrack-companion-\(config.label)"
    }

    /// `screen -S <name> -X quit` — ends the managed session if present.
    private func quitScreenCommand() -> String {
        "screen -S \(screenSessionName()) -X quit || true"
    }

    /// `pkill -9 -f cli.js.*<port>` — hard-kills the daemon bound to
    /// this instance's port. The `.*<port>` pattern matches the
    /// `dist/cli.js --vault … --port <port>` argv, so it never touches
    /// the OTHER instance.
    private func pkillCommand() -> String {
        "pkill -9 -f 'cli.js.*\(config.port)' || true"
    }

    /// `screen -dmS <name> zsh -lc scripts/run-test-companion.sh` —
    /// launches detached. The login shell (`-lc`) sources the profile
    /// so PATH resolves bun/npx. run-test-companion.sh derives its port
    /// from SIDETRACK_TEST_PORT, so we pass it for the non-default
    /// instance.
    private func startScreenCommand() -> String {
        let portEnv = "SIDETRACK_TEST_PORT=\(config.port)"
        let vaultEnv = "SIDETRACK_TEST_VAULT=\(shellQuote(config.vaultRoot))"
        // scripts/run-test-companion.sh is invoked relative to the repo
        // root (set as the process cwd below).
        return
            "\(portEnv) \(vaultEnv) screen -dmS \(screenSessionName()) /bin/zsh -lc 'exec scripts/run-test-companion.sh'"
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Run a sequence of shell commands from the repo root, off the main
    /// thread, and refresh state afterward. Requires the repo root to be
    /// discoverable; surfaces a clear message if not.
    private func runManaged(steps: [String], actionName: String) {
        guard let repoRoot = RepoLocator.resolve(codePath: version?.codePath)
        else {
            lastActionMessage =
                "\(actionName) failed: repo not found (set it in Settings)"
            return
        }
        let script = steps.joined(separator: " ; ")
        lastActionMessage = "\(actionName)…"
        Task.detached { [weak self] in
            let result = Self.runShell(script, cwd: repoRoot)
            await MainActor.run {
                guard let self else { return }
                switch result {
                case .success:
                    self.lastActionMessage = "\(actionName) issued"
                case .failure(let message):
                    self.lastActionMessage = "\(actionName) failed: \(message)"
                }
            }
            // Give the daemon a moment, then re-poll so the UI updates.
            try? await Task.sleep(for: .seconds(1))
            await self?.pollOnce()
        }
    }

    /// Run a command string through `/bin/zsh -lc` from `cwd`. A login
    /// shell so PATH picks up bun/npx exactly as the manual recipe does.
    /// nonisolated so it can be invoked from a detached task and never
    /// runs on the main actor (Process.waitUntilExit blocks).
    private nonisolated static func runShell(_ command: String, cwd: String)
        -> ShellResult
    {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]
        process.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        let errPipe = Pipe()
        process.standardError = errPipe
        process.standardOutput = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus == 0 {
                return .success
            }
            let data = errPipe.fileHandleForReading.readDataToEndOfFile()
            let stderr = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return .failure(
                stderr.isEmpty
                    ? "exit \(process.terminationStatus)" : stderr)
        } catch {
            return .failure(error.localizedDescription)
        }
    }
}
