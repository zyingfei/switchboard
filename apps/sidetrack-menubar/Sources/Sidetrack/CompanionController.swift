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
    /// The TEST instance's status, polled every cycle regardless of which
    /// instance the picker watches — the "tick" in the Test rig section
    /// supervises the test companion even while the app watches daily.
    /// When the picker IS on test, this mirrors `status` (one probe, not
    /// two, against the same port).
    @Published private(set) var testStatus: CompanionStatus = .unknown
    /// Whether a test-companion start/stop issued from the tick is still
    /// settling — the Toggle renders disabled during the transition so a
    /// slow daemon boot doesn't read as "the tick didn't take".
    @Published private(set) var testTransitioning = false
    /// Whether the CDP endpoint of the test BROWSER (:9222) answers — the
    /// green dot next to "Start test browser".
    @Published private(set) var testBrowserRunning = false
    /// Opt-in for the companion-side local LLM (SIDETRACK_LOCAL_LLM=1 on
    /// the test companion's start command). Persisted; takes effect on
    /// the NEXT start/restart of the test companion — the first sweep
    /// downloads a ~1GB open model (Gemma-class) into the companion's
    /// model cache, hence explicit opt-in, never a default.
    @Published var localLlmOptIn: Bool {
        didSet {
            UserDefaults.standard.set(
                localLlmOptIn, forKey: Self.localLlmDefaultsKey)
        }
    }
    static let localLlmDefaultsKey = "SidetrackLocalLlmOptIn"
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
        self.localLlmOptIn = UserDefaults.standard.bool(
            forKey: Self.localLlmDefaultsKey)
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
        await pollTestRig()
    }

    /// Probe the fixed TEST instance + the test browser's CDP port. The
    /// test-rig section renders from these regardless of the watched
    /// instance. When the picker is on test, reuse the main probe result
    /// instead of a second identical request.
    private func pollTestRig() async {
        if config.instance == .test {
            testStatus = status
        } else {
            let testClient = CompanionClient(
                config: CompanionConfig(instance: .test))
            switch await testClient.probe() {
            case .running: testStatus = .running
            case .stopped: testStatus = .stopped
            case .unreachable: testStatus = .unreachable
            case .error(let message): testStatus = .error(message)
            }
        }
        testBrowserRunning = await Self.probeCdpPort()
    }

    /// True when http://127.0.0.1:9222/json/version answers — the test
    /// browser's DevTools endpoint. Unauthenticated by design (CDP), so a
    /// bare GET with a short timeout is the whole probe.
    private nonisolated static func probeCdpPort() async -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:9222/json/version")!)
        request.timeoutInterval = 2
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
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

    // MARK: - Test rig actions

    /// The "tick": start/stop the TEST companion by intent, independent
    /// of which instance the picker watches. Same screen recipe as the
    /// watched-instance actions, pinned to the test config.
    func setTestCompanion(running: Bool) {
        let test = CompanionConfig(instance: .test)
        testTransitioning = true
        if running {
            runManaged(
                steps: [startScreenCommand(for: test)],
                actionName: "Start test companion",
                settle: { [weak self] in await self?.settleTestTransition() })
        } else {
            runManaged(
                steps: [quitScreenCommand(for: test), pkillCommand(for: test)],
                actionName: "Stop test companion",
                settle: { [weak self] in await self?.settleTestTransition() })
        }
    }

    private func settleTestTransition() async {
        // A cold companion boot takes ~15-25s before /v1/version answers;
        // keep the toggle disabled through a few polls so it doesn't
        // bounce back visually before the daemon is up.
        for _ in 0..<8 {
            try? await Task.sleep(for: .seconds(3))
            await pollTestRig()
            if testStatus == .running || testStatus == .stopped { break }
        }
        testTransitioning = false
    }

    /// Launch the test BROWSER (Chrome for Testing + the unpacked
    /// extension + CDP :9222) via the repo's own launcher, detached in a
    /// screen session so quitting this app never kills the browser.
    /// bun lives in ~/.bun/bin which login shells do NOT put on PATH
    /// (it's added in .zshrc, interactive-only) — prepend it explicitly.
    func startTestBrowser() {
        runManaged(
            steps: [
                "screen -dmS sidetrack-test-browser /bin/zsh -lc 'cd packages/sidetrack-extension && PATH=\"$HOME/.bun/bin:$PATH\" exec bun run e2e:chrome-debug'"
            ],
            actionName: "Start test browser",
            settle: { [weak self] in await self?.pollTestRig() })
    }

    /// The one-paste pairing token for the TEST companion
    /// (st-pair://17374/<key>), written by the daemon to
    /// <vault>/_BAC/.config/pair.txt. Read at call time — never cached,
    /// never hardcoded. Nil when the companion hasn't written it yet.
    func testPairToken() -> String? {
        let path = CompanionConfig(instance: .test).vaultRoot
            + "/_BAC/.config/pair.txt"
        guard
            let raw = try? String(contentsOfFile: path, encoding: .utf8)
        else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    /// Trigger a companion-side title-synthesis sweep on the TEST
    /// companion (POST /v1/enrichment/titles/sweep) and follow the job
    /// status briefly. The sweep runs in the daemon's background — a
    /// cold first run downloads the model (minutes); we surface that
    /// honestly instead of spinning forever.
    func runTitleSweep() {
        let test = CompanionConfig(instance: .test)
        lastActionMessage = "Title sweep…"
        Task { [weak self] in
            guard let self else { return }
            guard let first = await Self.sweepRequest(config: test, method: "POST")
            else {
                self.lastActionMessage = "Sweep failed: companion not answering"
                return
            }
            if first["disabled"] as? Bool == true {
                self.lastActionMessage =
                    "Local AI is off in the running companion — tick the box, then restart the test companion"
                return
            }
            // Follow the job for up to ~60s; beyond that (cold model
            // download) hand off to the user with an honest message.
            for _ in 0..<12 {
                try? await Task.sleep(for: .seconds(5))
                guard
                    let status = await Self.sweepRequest(
                        config: test, method: "GET")
                else { continue }
                let state = status["state"] as? String ?? "?"
                let generated = status["generated"] as? Int ?? 0
                let accepted = status["accepted"] as? Int ?? 0
                if state == "done" {
                    self.lastActionMessage =
                        "Sweep done — \(generated) generated · \(accepted) accepted"
                    return
                }
                if state == "error" {
                    let message = status["error"] as? String ?? "unknown"
                    self.lastActionMessage = "Sweep error: \(message)"
                    return
                }
                self.lastActionMessage =
                    "Sweep running… (\(generated) generated so far)"
            }
            self.lastActionMessage =
                "Sweep still running (first run downloads the model — check Health later)"
        }
    }

    /// One authenticated request against the sweep route. Returns the
    /// decoded top-level JSON object (the companion wraps in `data`; we
    /// unwrap when present), or nil on transport failure.
    private nonisolated static func sweepRequest(
        config: CompanionConfig, method: String
    ) async -> [String: Any]? {
        var request = URLRequest(
            url: config.baseURL.appendingPathComponent("v1/enrichment/titles/sweep"))
        request.httpMethod = method
        request.timeoutInterval = 10
        if let raw = try? String(
            contentsOfFile: config.bridgeKeyPath, encoding: .utf8)
        {
            let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                request.setValue(key, forHTTPHeaderField: "x-bac-bridge-key")
            }
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
            (response as? HTTPURLResponse)?.statusCode == 200,
            let json = try? JSONSerialization.jsonObject(with: data)
                as? [String: Any]
        else { return nil }
        return (json["data"] as? [String: Any]) ?? json
    }

    func copyTestPairToken() {
        guard let token = testPairToken() else {
            lastActionMessage = "No pair token yet — start the test companion once"
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(token, forType: .string)
        lastActionMessage = "Pairing URL copied"
    }

    // MARK: - Shell-out plumbing

    private func screenSessionName(for target: CompanionConfig) -> String {
        "sidetrack-companion-\(target.label)"
    }

    /// `screen -S <name> -X quit` — ends the managed session if present.
    private func quitScreenCommand(for target: CompanionConfig? = nil) -> String {
        let target = target ?? config
        return "screen -S \(screenSessionName(for: target)) -X quit || true"
    }

    /// `pkill -9 -f cli.js.*<port>` — hard-kills the daemon bound to
    /// this instance's port. The `.*<port>` pattern matches the
    /// `dist/cli.js --vault … --port <port>` argv, so it never touches
    /// the OTHER instance.
    private func pkillCommand(for target: CompanionConfig? = nil) -> String {
        let target = target ?? config
        return "pkill -9 -f 'cli.js.*\(target.port)' || true"
    }

    /// `screen -dmS <name> zsh -lc scripts/run-test-companion.sh` —
    /// launches detached. The login shell (`-lc`) sources the profile
    /// so PATH resolves bun/npx. run-test-companion.sh derives its port
    /// from SIDETRACK_TEST_PORT, so we pass it for the non-default
    /// instance.
    private func startScreenCommand(for target: CompanionConfig? = nil) -> String {
        let target = target ?? config
        let portEnv = "SIDETRACK_TEST_PORT=\(target.port)"
        let vaultEnv = "SIDETRACK_TEST_VAULT=\(shellQuote(target.vaultRoot))"
        // The local-LLM opt-in rides the start command for the TEST
        // instance only (the daily companion is never opted in from
        // here) — flipping the box takes effect on the next start.
        let llmEnv =
            (target.instance == .test && localLlmOptIn)
            ? "SIDETRACK_LOCAL_LLM=1 " : ""
        // scripts/run-test-companion.sh is invoked relative to the repo
        // root (set as the process cwd below).
        return
            "\(portEnv) \(vaultEnv) \(llmEnv)screen -dmS \(screenSessionName(for: target)) /bin/zsh -lc 'exec scripts/run-test-companion.sh'"
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Run a sequence of shell commands from the repo root, off the main
    /// thread, and refresh state afterward. Requires the repo root to be
    /// discoverable; surfaces a clear message if not. `settle` (when
    /// given) replaces the default single re-poll — the test-rig tick
    /// uses it to keep its toggle disabled until the slow daemon boot
    /// resolves to running/stopped.
    private func runManaged(
        steps: [String],
        actionName: String,
        settle: (@MainActor () async -> Void)? = nil
    ) {
        guard let repoRoot = RepoLocator.resolve(codePath: version?.codePath)
        else {
            lastActionMessage =
                "\(actionName) failed: repo not found (set it in Settings)"
            if let settle {
                Task { await settle() }
            }
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
            if let settle {
                await settle()
            } else {
                await self?.pollOnce()
            }
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
