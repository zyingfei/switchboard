import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';

const wsUrl = new URL('ws://127.0.0.1:8721/mcp?token=_5Y4cCMr6vvqp-tE6cIUfNFF6hvYGhBDplvtvOSf0IM');
const threadUrl = 'https://chatgpt.com/c/69fa8f0f-8b24-8330-be54-7de1740f11bc';

const transport = new WebSocketClientTransport(wsUrl);
const client = new Client({ name: 'sidetrack-probe', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
const result = await client.callTool({ name: 'bac.turns', arguments: { threadUrl, limit: 20 } });
const data = result?.structuredContent?.data ?? [];
console.log(`Total turns: ${data.length}`);
for (const t of data) {
  const text = t?.text ?? '';
  console.log(`[${t?.role}] ord=${t?.ordinal} len=${text.length} capturedAt=${t?.capturedAt}`);
  console.log('  head:', JSON.stringify(text.slice(0, 200)));
  if (text.length > 400) console.log('  tail:', JSON.stringify(text.slice(-200)));
}
await client.close();
