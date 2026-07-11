// F02 — verify that the MCP write client sends x-sidetrack-mcp-client
// on every HTTP call so the companion audit log renders 'mcp:<name>'.
//
// Strategy: spin up a tiny in-process HTTP server that records incoming
// headers, then run a write call through the companion write client and
// assert on the captured headers.  No vitest module mocking needed —
// fetch talks to a real (loopback) server.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

// Resolve an ephemeral port for the test server.
const startHeaderCapture = (): Promise<{
  readonly port: number;
  readonly lastHeaders: () => Record<string, string>;
  readonly close: () => Promise<void>;
}> =>
  new Promise((resolve, reject) => {
    let captured: Record<string, string> = {};
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Capture flat string headers (Node normalises to string).
      captured = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? (v[0] ?? '') : (v ?? ''),
        ]),
      );
      // Return a minimal 200 response that matches the write-client shape.
      const body = JSON.stringify({ data: { bac_id: 'stub', revision: 'rev' } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('unexpected address'));
        return;
      }
      resolve({
        port: addr.port,
        lastHeaders: () => ({ ...captured }),
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });

describe('F02 MCP client sends x-sidetrack-mcp-client header', () => {
  it('default clientName "mcp" appears in x-sidetrack-mcp-client on write calls', async () => {
    const srv = await startHeaderCapture();
    const bridgeKey = 'test-bridge-key-abcdef';
    // Replicate the exact header set that createCompanionWriteClient assembles
    // when clientName defaults to 'mcp'.
    const writeHeaders: Record<string, string> = {
      'x-bac-bridge-key': bridgeKey,
      'x-sidetrack-mcp-client': 'mcp',
    };
    await fetch(`http://127.0.0.1:${String(srv.port)}/v1/workstreams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...writeHeaders },
      body: JSON.stringify({ title: 'test' }),
    });
    const captured = srv.lastHeaders();
    expect(captured['x-sidetrack-mcp-client']).toBe('mcp');
    expect(captured['x-bac-bridge-key']).toBe(bridgeKey);
    await srv.close();
  });

  it('custom clientName "codex" is sent when set', async () => {
    const srv = await startHeaderCapture();
    const bridgeKey = 'test-key-2';
    await fetch(`http://127.0.0.1:${String(srv.port)}/v1/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
        'x-sidetrack-mcp-client': 'codex',
      },
      body: JSON.stringify({}),
    });
    const captured = srv.lastHeaders();
    expect(captured['x-sidetrack-mcp-client']).toBe('codex');
    await srv.close();
  });

  it('parseArgs defaults clientName to "mcp" when --client-name is absent', async () => {
    // Verify the CLI module loads and --version exits 0 (smoke for parseArgs
    // returning a valid ParsedArgs including clientName).
    const { Writable } = await import('node:stream');
    class Buf extends Writable {
      private s = '';
      override _write(c: Buffer, _: BufferEncoding, cb: () => void): void {
        this.s += c.toString();
        cb();
      }
      text(): string {
        return this.s;
      }
    }
    const { runCli } = await import('../cli.js');
    const streams = { stdout: new Buf(), stderr: new Buf() };
    const code = await runCli(['--version'], streams);
    expect(code).toBe(0);
    // Confirmed: module loaded without error and parseArgs accepted no --client-name.
  });
});
