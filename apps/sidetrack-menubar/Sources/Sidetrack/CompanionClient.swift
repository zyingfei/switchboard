import Foundation
import Network

/// The outcome of one poll of `/v1/version`.
enum CompanionProbe {
    /// Fully answered: version payload decoded.
    case running(VersionData)
    /// Port is bound (a process is listening) but the HTTP request did
    /// not complete in time — the daemon can take 30s+ under load
    /// (drain / rebuild). Distinct from `.stopped` so the user knows
    /// "it's there, just busy" and does NOT hit Start.
    case unreachable(reason: String)
    /// Nothing is listening on the port (connection refused). The
    /// companion is genuinely down.
    case stopped
    /// A process answered but the response was not the version shape
    /// (wrong service on the port, auth rejected, malformed JSON).
    case error(String)
}

/// Read-only client for the companion's loopback API. Localhost only —
/// the app makes ZERO external network calls.
///
/// Every request is bounded by a short timeout so a wedged daemon can
/// never block the UI. A separate, even shorter NWConnection TCP probe
/// distinguishes "port bound but slow" (UNREACHABLE) from "nothing
/// listening" (STOPPED) — cheaply, without waiting out the HTTP
/// timeout.
struct CompanionClient {
    let config: CompanionConfig

    /// HTTP request timeout. Generous enough to ride out a busy
    /// daemon's slow response, short enough to keep the ~3s poll from
    /// piling up. The UI never awaits this on the main actor beyond one
    /// in-flight poll.
    private let requestTimeout: TimeInterval = 8

    /// Read the loopback bridge key from disk. Returns nil if the file
    /// is missing/unreadable (unpaired vault). Never hardcoded.
    private func readBridgeKey() -> String? {
        guard
            let raw = try? String(
                contentsOfFile: config.bridgeKeyPath, encoding: .utf8)
        else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Poll `/v1/version` once. `/v1/version` is unauthenticated on the
    /// companion, but we send the bridge key when available so the poll
    /// is indistinguishable from a normal extension attach and works
    /// even if the endpoint is ever locked down.
    func probe() async -> CompanionProbe {
        let url = config.baseURL.appendingPathComponent("v1/version")
        var request = URLRequest(url: url)
        request.timeoutInterval = requestTimeout
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let key = readBridgeKey() {
            request.setValue(key, forHTTPHeaderField: "x-bac-bridge-key")
        }

        let session = URLSession(configuration: ephemeralConfig())
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .error("non-HTTP response")
            }
            guard http.statusCode == 200 else {
                return .error("HTTP \(http.statusCode)")
            }
            do {
                let envelope = try JSONDecoder().decode(
                    VersionEnvelope.self, from: data)
                return .running(envelope.data)
            } catch {
                return .error("bad version payload")
            }
        } catch let urlError as URLError {
            // Connection refused ⇒ nothing bound ⇒ STOPPED. A timeout or
            // a "cannot connect" that is not a refusal, when the port is
            // in fact bound, means the daemon is up but slow ⇒
            // UNREACHABLE. We disambiguate with a cheap TCP probe.
            if urlError.code == .cannotConnectToHost
                || urlError.code == .networkConnectionLost
                || urlError.code == .cannotFindHost
            {
                return await portBound() ? .unreachable(reason: "no response")
                    : .stopped
            }
            if urlError.code == .timedOut {
                return await portBound()
                    ? .unreachable(reason: "timed out")
                    : .stopped
            }
            return .error(urlError.localizedDescription)
        } catch {
            return .error(error.localizedDescription)
        }
    }

    private func ephemeralConfig() -> URLSessionConfiguration {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = requestTimeout
        cfg.timeoutIntervalForResource = requestTimeout
        cfg.waitsForConnectivity = false
        // Loopback only — never route through a proxy or the network.
        cfg.connectionProxyDictionary = [:]
        return cfg
    }

    /// Cheap TCP reachability check: is *something* listening on the
    /// port? Uses NWConnection with a 1.5s deadline. A `.ready` state
    /// means bound (busy daemon); a `.failed`/POSIX-refused means
    /// nothing there. This is the STOPPED-vs-UNREACHABLE discriminator.
    private func portBound() async -> Bool {
        guard let port = NWEndpoint.Port(rawValue: UInt16(config.port)) else {
            return false
        }
        return await withCheckedContinuation { continuation in
            PortProbe(host: "127.0.0.1", port: port, deadline: 1.5)
                .run(continuation: continuation)
        }
    }
}

/// One-shot TCP reachability probe. Resumes its continuation exactly
/// once — whichever of the connection state handler or the deadline
/// timer fires first wins. `@unchecked Sendable` because all mutable
/// state is guarded by the internal lock, so it may cross the
/// concurrency boundaries the two callbacks run on.
private final class PortProbe: @unchecked Sendable {
    private let connection: NWConnection
    private let deadline: TimeInterval
    private let lock = NSLock()
    private var finished = false
    private var continuation: CheckedContinuation<Bool, Never>?
    // Self-reference held until the probe resolves, so the object stays
    // alive between `run()` returning and a callback firing (nothing
    // else retains it). Cleared in `finish` to break the cycle.
    private var selfHold: PortProbe?

    init(host: String, port: NWEndpoint.Port, deadline: TimeInterval) {
        self.connection = NWConnection(
            host: NWEndpoint.Host(host), port: port, using: .tcp)
        self.deadline = deadline
    }

    func run(continuation: CheckedContinuation<Bool, Never>) {
        self.continuation = continuation
        self.selfHold = self
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                self.finish(true)
            case .failed, .cancelled:
                self.finish(false)
            default:
                break
            }
        }
        connection.start(queue: .global(qos: .utility))
        DispatchQueue.global(qos: .utility)
            .asyncAfter(deadline: .now() + deadline) {
                self.finish(false)
            }
    }

    private func finish(_ bound: Bool) {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        finished = true
        let cont = continuation
        continuation = nil
        lock.unlock()
        connection.cancel()
        cont?.resume(returning: bound)
        // Release the self-hold last, allowing deallocation once the
        // in-flight callbacks unwind.
        selfHold = nil
    }
}
