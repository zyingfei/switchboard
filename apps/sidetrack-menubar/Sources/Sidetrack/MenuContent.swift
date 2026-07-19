import SwiftUI

/// The dropdown shown when the menu-bar item is clicked. Renders the
/// companion's live identity + build provenance and the management
/// actions. Kept to a single scroll-free column sized for a menu-bar
/// popover.
struct MenuContent: View {
    @ObservedObject var controller: CompanionController

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider()
            if controller.status == .stopped {
                stoppedBlock
            } else {
                detailBlock
            }
            Divider()
            actions
            if let message = controller.lastActionMessage {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(14)
        .frame(width: 320)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: controller.status.glyphName)
                .foregroundStyle(controller.status.tint)
            VStack(alignment: .leading, spacing: 1) {
                Text("Sidetrack companion")
                    .font(.headline)
                Text(controller.status.title)
                    .font(.subheadline)
                    .foregroundStyle(controller.status.tint)
            }
            Spacer()
            instancePicker
        }
    }

    private var instancePicker: some View {
        Picker("", selection: instanceBinding) {
            ForEach(CompanionInstance.allCases) { instance in
                Text(instance.displayName).tag(instance)
            }
        }
        .labelsHidden()
        .frame(width: 120)
        .help("Switch which companion instance to watch")
    }

    private var instanceBinding: Binding<CompanionInstance> {
        Binding(
            get: { controller.config.instance },
            set: { controller.config = CompanionConfig(instance: $0) }
        )
    }

    // MARK: - Stopped

    private var stoppedBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                "Companion is not running on port \(controller.config.port).",
                systemImage: "bolt.slash")
                .font(.callout)
                .foregroundStyle(.secondary)
            Button {
                controller.startCompanion()
            } label: {
                Label("Start companion", systemImage: "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .buttonStyle(.borderedProminent)
        }
    }

    // MARK: - Detail

    private var detailBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let v = controller.version {
                row("Version", v.companionVersion)
                buildRow(v)
                if let branch = v.buildBranch {
                    row("Branch", branch)
                }
                row("PID", String(v.pid))
                row("Port", String(controller.config.port))
                if let label = v.instanceLabel {
                    row("Instance", label)
                }
                if let up = controller.uptimeDescription {
                    row("Uptime", up)
                }
                if let vault = v.vaultRoot ?? Optional(controller.config.vaultRoot) {
                    row("Vault", condensePath(vault))
                }
            } else if controller.status == .unreachable {
                Label(
                    "Port \(controller.config.port) is bound but the daemon isn't responding — it may be busy (drain/rebuild can take 30s+).",
                    systemImage: "hourglass")
                    .font(.callout)
                    .foregroundStyle(.orange)
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Checking companion…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// buildSha with a freshness hint. When present, this is the field
    /// that answers "which build is running" — the whole reason for
    /// Part A.
    private func buildRow(_ v: VersionData) -> some View {
        HStack(alignment: .top) {
            Text("Build")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(v.buildSha ?? "un-stamped")
                    .font(.caption.monospaced())
                    .foregroundStyle(v.buildSha == nil ? .secondary : .primary)
                    .textSelection(.enabled)
                if let time = v.buildTime {
                    Text(time)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            Spacer()
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(.caption)
                .textSelection(.enabled)
            Spacer()
        }
    }

    /// Trim a long vault path to the trailing components so it fits.
    private func condensePath(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    // MARK: - Actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button {
                    controller.restartCompanion()
                } label: {
                    Label("Restart", systemImage: "arrow.clockwise")
                }
                Button {
                    controller.stopCompanion()
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                if controller.status != .running {
                    Button {
                        controller.startCompanion()
                    } label: {
                        Label("Start", systemImage: "play.fill")
                    }
                }
            }
            HStack(spacing: 8) {
                Button {
                    controller.openVault()
                } label: {
                    Label("Open Vault", systemImage: "folder")
                }
                Button {
                    controller.copyDiagnostics()
                } label: {
                    Label("Copy Diagnostics", systemImage: "doc.on.doc")
                }
            }
            Divider()
            Button(role: .destructive) {
                NSApplication.shared.terminate(nil)
            } label: {
                Label("Quit Sidetrack", systemImage: "power")
            }
            .keyboardShortcut("q")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }
}
