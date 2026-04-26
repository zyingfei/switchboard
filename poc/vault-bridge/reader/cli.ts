import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const pad2 = (value: number): string => String(value).padStart(2, '0');

const dateKey = (date = new Date()): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const readVaultArg = (): string => {
  const { values } = parseArgs({
    options: {
      vault: { type: 'string', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.vault) {
    process.stderr.write('Usage: npm start -- --vault /path/to/vault\n');
    process.exit(values.help ? 0 : 1);
  }
  return path.resolve(values.vault);
};

const readNewBytes = async (
  filePath: string,
  offset: number,
): Promise<{ readonly text: string; readonly offset: number }> => {
  const file = await open(filePath, 'r');
  try {
    const info = await file.stat();
    if (info.size <= offset) {
      return { text: '', offset };
    }
    const buffer = Buffer.alloc(info.size - offset);
    await file.read(buffer, 0, buffer.length, offset);
    return { text: buffer.toString('utf8'), offset: info.size };
  } finally {
    await file.close();
  }
};

const main = async (): Promise<void> => {
  const vaultPath = readVaultArg();
  const eventsDir = path.join(vaultPath, '_BAC', 'events');
  const filePath = path.join(eventsDir, `${dateKey()}.jsonl`);
  await mkdir(eventsDir, { recursive: true });

  let offset = await stat(filePath).then((info) => info.size).catch(() => 0);
  let buffered = '';
  process.stderr.write(`Tailing ${filePath}\n`);

  setInterval(() => {
    void (async () => {
      const next = await readNewBytes(filePath, offset).catch(() => ({ text: '', offset }));
      offset = next.offset;
      buffered += next.text;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          process.stdout.write(`${line}\n`);
        }
      }
    })();
  }, 200);
};

await main();
