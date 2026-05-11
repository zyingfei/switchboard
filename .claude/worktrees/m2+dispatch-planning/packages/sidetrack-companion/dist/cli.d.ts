#!/usr/bin/env node
import type { Writable } from 'node:stream';
export declare const companionVersion = "0.0.0";
export interface CliStreams {
    readonly stdout: Writable;
    readonly stderr: Writable;
}
export declare const renderHelp: () => string;
export declare const runCli: (argv: readonly string[], streams: CliStreams) => Promise<number>;
//# sourceMappingURL=cli.d.ts.map