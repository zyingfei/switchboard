import { useCallback, useEffect, useRef, useState } from 'react';

// On-device AI (Gemini Nano / Chrome built-in Prompt API) availability row
// for the Health panel's Experiments drill.
//
// This is a BROWSER capability, not a companion candidate lane — the panel
// probes its own extension context (the Prompt API is exposed to extension
// pages on Chrome 138+) and reports what it finds. PoC evidence
// (poc/nano-title-synthesis/README.md): the API surface exists in the test
// browser but Chrome for Testing cannot deliver the model component; regular
// Chrome can. This row makes the per-browser truth visible so the title-
// synthesis quality gate can run where the model actually lands.
//
// The multi-GB model download starts ONLY from the explicit button —
// availability() is a passive read; create() is the download trigger and is
// never called without user intent.

// Minimal ambient shape for the built-in Prompt API — not yet in TS's DOM
// lib. Feature-detected at runtime; every call is guarded.
interface BuiltinLanguageModel {
  availability: () => Promise<string>;
  create: (options?: {
    monitor?: (m: {
      addEventListener: (type: 'downloadprogress', cb: (e: { loaded: number }) => void) => void;
    }) => void;
  }) => Promise<{ destroy: () => void }>;
}

const builtinLanguageModel = (): BuiltinLanguageModel | undefined => {
  const candidate = (globalThis as { LanguageModel?: unknown }).LanguageModel;
  if (candidate === undefined || candidate === null) return undefined;
  return candidate as BuiltinLanguageModel;
};

export type OnDeviceAiState =
  | 'no-api'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available'
  | 'error';

const STATE_COPY: Record<OnDeviceAiState, string> = {
  'no-api': 'not exposed by this browser',
  unavailable: 'this device/browser cannot run the model',
  downloadable: 'model not downloaded yet',
  downloading: 'model downloading…',
  available: 'ready',
  error: 'probe failed',
};

export function OnDeviceAiRow() {
  const [state, setState] = useState<OnDeviceAiState>('no-api');
  const [progress, setProgress] = useState<number | null>(null);
  const [kicked, setKicked] = useState(false);
  const mountedRef = useRef(true);

  const probe = useCallback(async (): Promise<void> => {
    const lm = builtinLanguageModel();
    if (lm === undefined) {
      setState('no-api');
      return;
    }
    try {
      const availability = await lm.availability();
      if (!mountedRef.current) return;
      setState(
        availability === 'available' ||
          availability === 'downloadable' ||
          availability === 'downloading' ||
          availability === 'unavailable'
          ? availability
          : 'error',
      );
    } catch {
      if (mountedRef.current) setState('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void probe();
    return () => {
      mountedRef.current = false;
    };
  }, [probe]);

  // While a download is in flight, refresh the availability read on a slow
  // cadence so the row converges to 'available' without a manual reopen.
  useEffect(() => {
    if (state !== 'downloading') return undefined;
    const timer = window.setInterval(() => {
      void probe();
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [state, probe]);

  const startDownload = useCallback((): void => {
    const lm = builtinLanguageModel();
    if (lm === undefined) return;
    setKicked(true);
    void lm
      .create({
        monitor: (m) => {
          m.addEventListener('downloadprogress', (e) => {
            if (mountedRef.current) setProgress(e.loaded);
          });
        },
      })
      .then((session) => {
        session.destroy();
        if (mountedRef.current) setState('available');
      })
      .catch(() => {
        if (mountedRef.current) void probe();
      });
    setState('downloading');
  }, [probe]);

  return (
    <div className="sx-callout" data-testid="hp-ondevice-ai">
      <strong>On-device AI (Gemini Nano)</strong>
      {' · '}
      <span data-testid="hp-ondevice-ai-state">{STATE_COPY[state]}</span>
      {state === 'downloading' && progress !== null ? (
        <span className="mono"> {String(Math.round(progress * 100))}%</span>
      ) : null}
      {state === 'downloadable' && !kicked ? (
        <button
          type="button"
          className="sx-btn"
          style={{ marginLeft: 8 }}
          onClick={startDownload}
        >
          Download model
        </button>
      ) : null}
    </div>
  );
}
