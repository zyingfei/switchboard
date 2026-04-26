import type { RecallMessage, RecallResponse } from '../shared/messages';

const isRecallMessage = (message: unknown): message is RecallMessage =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  typeof (message as { type: unknown }).type === 'string' &&
  String((message as { type: unknown }).type).startsWith('bac.recall.');

export const createMessageRouter = (coordinator: {
  handle(message: RecallMessage): Promise<RecallResponse>;
}) => {
  return (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: RecallResponse) => void) => {
    if (!isRecallMessage(message)) {
      return false;
    }
    void coordinator.handle(message).then(sendResponse);
    return true;
  };
};
