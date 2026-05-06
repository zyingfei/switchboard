import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
const transport = new WebSocketClientTransport(
  new URL('ws://127.0.0.1:8721/mcp?token=_5Y4cCMr6vvqp-tE6cIUfNFF6hvYGhBDplvtvOSf0IM'),
);
const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);
const r = await client.callTool({
  name: 'bac.list_annotations',
  arguments: { url: 'https://chatgpt.com/c/69fa8f0f-8b24-8330-be54-7de1740f11bc', limit: 20 },
});
const items = r?.structuredContent?.data ?? [];
console.log(`Total annotations: ${items.length}`);
for (const ann of items) {
  console.log(`\nbac_id: ${ann.bac_id}`);
  console.log(`  url: ${ann.url}`);
  console.log(`  note: ${(ann.note ?? '').slice(0, 80)}`);
  console.log(`  anchor.textQuote.exact: ${JSON.stringify(ann.anchor?.textQuote?.exact)}`);
  console.log(`  anchor.textQuote.prefix: ${JSON.stringify(ann.anchor?.textQuote?.prefix)}`);
  console.log(`  anchor.textQuote.suffix: ${JSON.stringify(ann.anchor?.textQuote?.suffix)}`);
  console.log(`  anchor.textPosition: ${JSON.stringify(ann.anchor?.textPosition)}`);
  console.log(`  anchor.cssSelector: ${JSON.stringify(ann.anchor?.cssSelector)}`);
}
await client.close();
