import type { BridgeEvent, TransportServer } from '../model';
import { readErrorMessage } from '../model';
import type { BridgeRuntime } from '../runtime';

interface NativeMessage {
  readonly id?: string;
  readonly type: 'status' | 'event' | 'tick.start' | 'tick.stop';
  readonly event?: BridgeEvent;
}

const writeFrame = (value: unknown): void => {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
};

export class NativeMessagingTransportServer implements TransportServer {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly runtime: BridgeRuntime,
    private readonly allowedExtensionId?: string,
  ) {}

  async start(): Promise<void> {
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      void this.drain();
    });
  }

  async stop(): Promise<void> {
    process.stdin.removeAllListeners('data');
  }

  private async drain(): Promise<void> {
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.byteLength < length + 4) {
        return;
      }
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      await this.handle(JSON.parse(payload.toString('utf8')) as NativeMessage);
    }
  }

  private async handle(message: NativeMessage): Promise<void> {
    try {
      if (this.allowedExtensionId && process.env.CHROME_EXTENSION_ID !== this.allowedExtensionId) {
        writeFrame({ id: message.id, ok: false, error: 'Native host extension id is not allowed' });
        return;
      }
      if (message.type === 'status') {
        writeFrame({ id: message.id, ok: true, status: this.runtime.status() });
        return;
      }
      if (message.type === 'event' && message.event) {
        const outcome = await this.runtime.writeEvent(message.event);
        writeFrame({ id: message.id, ok: true, outcome, status: this.runtime.status() });
        return;
      }
      if (message.type === 'tick.start') {
        this.runtime.startTick();
        writeFrame({ id: message.id, ok: true, status: this.runtime.status() });
        return;
      }
      if (message.type === 'tick.stop') {
        this.runtime.stopTick();
        writeFrame({ id: message.id, ok: true, status: this.runtime.status() });
        return;
      }
      writeFrame({ id: message.id, ok: false, error: 'Unknown native message' });
    } catch (error) {
      writeFrame({ id: message.id, ok: false, error: readErrorMessage(error) });
    }
  }
}
