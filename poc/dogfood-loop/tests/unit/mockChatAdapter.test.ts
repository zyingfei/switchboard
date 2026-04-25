import { describe, expect, it } from 'vitest';
import { waitForCompletion } from '../../src/adapters/adapterHealth';
import { MOCK_CHAT_CONFIGS, createDomMockChatAdapter } from '../../src/adapters/mockChatAdapter';

const createMockDom = () => {
  document.body.innerHTML = `
    <textarea data-mock-chat-input></textarea>
    <button data-mock-chat-send>Send</button>
    <p data-mock-chat-response></p>
  `;
  return document;
};

describe('mock chat adapter', () => {
  it('injects text into the mock DOM and can click send', async () => {
    const doc = createMockDom();
    let clicked = false;
    doc.querySelector('[data-mock-chat-send]')?.addEventListener('click', () => {
      clicked = true;
    });
    const adapter = createDomMockChatAdapter(MOCK_CHAT_CONFIGS['mock-chat-a'], doc);

    await adapter.injectInput(1, 'Review this note', { send: true });

    expect(doc.querySelector<HTMLTextAreaElement>('[data-mock-chat-input]')?.value).toBe(
      'Review this note',
    );
    expect(clicked).toBe(true);
  });

  it('waits until the fake response is marked done', async () => {
    const doc = createMockDom();
    const adapter = createDomMockChatAdapter(MOCK_CHAT_CONFIGS['mock-chat-b'], doc);
    setTimeout(() => {
      document.body.dataset.mockChatDone = 'true';
    }, 25);

    const completed = await waitForCompletion(() => adapter.detectCompletion(1), {
      intervalMs: 10,
      timeoutMs: 250,
    });

    expect(completed).toBe(true);
  });
});
