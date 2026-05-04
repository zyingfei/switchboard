# MCP Host Substrate

Sidetrack can store a flat trusted-server list in `chrome.storage.local` under
`sidetrack.mcpHost.servers` and call HTTP MCP `tools/list` and `tools/call`.

Deferred: consent UI, per-server trust toggles, SSE transport, and write-tool
gating. Bearer tokens currently use the same storage adapter because the
extension does not yet have a secret-storage port.
