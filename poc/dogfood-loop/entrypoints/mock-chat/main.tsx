import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MOCK_CHAT_CONFIGS,
  buildFakeAssistantResponse,
  type MockChatPageMessage,
  type MockChatProvider,
  type MockChatRuntimeMessage,
} from '../../src/adapters/mockChatAdapter';
import type { Turn } from '../../src/adapters/observedChat';
import './style.css';

type PortRequest = {
  type: 'MOCK_CHAT_PORT_REQUEST';
  requestId: string;
  message: MockChatPageMessage;
};

const isPortRequest = (value: unknown): value is PortRequest =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'MOCK_CHAT_PORT_REQUEST' &&
  typeof (value as { requestId?: unknown }).requestId === 'string';

const readParams = (): { provider: MockChatProvider; runId: string } => {
  const params = new URLSearchParams(location.search);
  const provider = params.get('provider');
  return {
    provider: provider === 'mock-chat-b' ? 'mock-chat-b' : 'mock-chat-a',
    runId: params.get('runId') ?? 'manual-run',
  };
};

const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const chunkResponse = (value: string): string[] => {
  const words = value.split(' ');
  const chunkSize = Math.max(4, Math.ceil(words.length / 4));
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    chunks.push(words.slice(index, index + chunkSize).join(' '));
  }
  return chunks;
};

function MockChatApp() {
  const { provider, runId } = useMemo(readParams, []);
  const config = MOCK_CHAT_CONFIGS[provider];
  const [prompt, setPromptState] = useState('');
  const [response, setResponseState] = useState('');
  const [done, setDoneState] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const promptRef = useRef(prompt);
  const responseRef = useRef(response);
  const doneRef = useRef(done);
  const streamingRef = useRef(streaming);

  const setPrompt = useCallback((next: string) => {
    promptRef.current = next;
    setPromptState(next);
  }, []);

  const setResponse = useCallback((next: string) => {
    responseRef.current = next;
    setResponseState(next);
  }, []);

  const setDone = useCallback((next: boolean) => {
    doneRef.current = next;
    document.body.dataset.mockChatDone = String(next);
    setDoneState(next);
  }, []);

  const postRuntimeMessage = useCallback((message: MockChatRuntimeMessage) => {
    chrome.runtime.sendMessage(message, () => undefined);
  }, []);

  const streamAssistantResponse = useCallback(
    async (promptText: string) => {
      if (streamingRef.current) {
        return;
      }
      streamingRef.current = true;
      setStreaming(true);
      setDone(false);
      setResponse('');
      const fullResponse = buildFakeAssistantResponse(provider, promptText);
      let accumulated = '';
      for (const chunk of chunkResponse(fullResponse)) {
        await delay(120);
        accumulated = `${accumulated}${accumulated ? ' ' : ''}${chunk}`;
        setResponse(accumulated);
        const turn = {
          id: `${runId}-assistant`,
          role: 'assistant',
          content: accumulated,
          status: 'streaming',
          provider,
          runId,
        } satisfies Turn;
        postRuntimeMessage({ type: 'MOCK_CHAT_TURN', runId, provider, turn });
      }
      setDone(true);
      streamingRef.current = false;
      setStreaming(false);
      const turn = {
        id: `${runId}-assistant`,
        role: 'assistant',
        content: fullResponse,
        status: 'done',
        provider,
        runId,
      } satisfies Turn;
      postRuntimeMessage({ type: 'MOCK_CHAT_DONE', runId, provider, turn });
    },
    [postRuntimeMessage, provider, runId, setDone, setResponse],
  );

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'mock-chat' });
    chrome.tabs.getCurrent((tab) => {
      port.postMessage({
        type: 'MOCK_CHAT_PORT_READY',
        runId,
        provider,
        tabId: tab?.id ?? -1,
      });
    });
    port.onMessage.addListener((rawMessage: unknown) => {
      if (!isPortRequest(rawMessage)) {
        return;
      }
      const { requestId, message } = rawMessage;
      if (message.type === 'MOCK_CHAT_INJECT') {
        setPrompt(message.text);
        if (message.send) {
          void streamAssistantResponse(message.text);
        }
        port.postMessage({
          type: 'MOCK_CHAT_PORT_RESPONSE',
          requestId,
          response: { ok: true },
        });
        return;
      }
      if (message.type === 'MOCK_CHAT_GET_STATE') {
        port.postMessage({
          type: 'MOCK_CHAT_PORT_RESPONSE',
          requestId,
          response: {
            ok: true,
            state: {
              promptText: promptRef.current,
              responseText: responseRef.current,
              done: doneRef.current,
            },
          },
        });
      }
    });
    return () => {
      port.disconnect();
    };
  }, [provider, runId, setPrompt, streamAssistantResponse]);

  return (
    <main className="mockShell">
      <header>
        <p className="eyebrow">Fixture provider</p>
        <h1>{config.title}</h1>
        <span data-testid="assistant-status" className={`status ${done ? 'done' : 'waiting'}`}>
          {done ? 'done' : streaming ? 'streaming' : 'idle'}
        </span>
      </header>

      <section className="chatSurface">
        <label>
          Prompt input
          <textarea
            data-mock-chat-input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <button
          data-mock-chat-send
          className="sendButton"
          disabled={!prompt.trim() || streaming}
          onClick={() => void streamAssistantResponse(prompt)}
        >
          Send
        </button>
        <article className="assistantTurn" aria-label="Assistant response">
          <strong>Assistant</strong>
          <p data-mock-chat-response>{response || 'No response yet.'}</p>
        </article>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <MockChatApp />
  </React.StrictMode>,
);
