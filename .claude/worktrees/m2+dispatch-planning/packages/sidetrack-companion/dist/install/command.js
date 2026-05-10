export const buildCompanionServiceCommand = (opts) => [
    ...(opts.companionCommand ?? [opts.companionBin ?? process.execPath]),
    '--vault',
    opts.vaultPath,
    '--port',
    String(opts.port),
    ...(opts.mcpPort === undefined ? [] : ['--mcp-port', String(opts.mcpPort)]),
    ...(opts.mcpBin === undefined ? [] : ['--mcp-bin', opts.mcpBin]),
    ...(opts.syncRelayLocalPort === undefined
        ? []
        : ['--sync-relay-local', String(opts.syncRelayLocalPort)]),
    ...(opts.syncRelay === undefined ? [] : ['--sync-relay', opts.syncRelay]),
];
//# sourceMappingURL=command.js.map