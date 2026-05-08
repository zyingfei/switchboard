declare module '@wlearn/lightgbm' {
  export class Dataset {
    constructor(data: Float32Array, nrow: number, ncol: number, params?: string);
    readonly handle: number;
    setLabel(labels: Float32Array): void;
    dispose(): void;
  }

  export class Booster {
    constructor(trainDataHandle: number, paramsStr: string);
    static loadModel(modelBytes: Uint8Array): Booster;
    update(): boolean;
    predict(
      data: Float32Array,
      nrow: number,
      ncol: number,
      options?: { readonly predictType?: number; readonly numIteration?: number },
    ): Float64Array;
    saveModel(): Uint8Array;
    dispose(): void;
  }

  export function loadLGB(options?: unknown): Promise<unknown>;
}
