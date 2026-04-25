export interface ThreadRef {
  tabId: number;
  provider: string;
  url: string;
  title: string;
}

export interface Turn {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  status: 'streaming' | 'done';
  provider: string;
  runId?: string;
}

export type Unsubscribe = () => void;

export interface ObservedChatAdapter {
  id: string;
  hostMatch: string[];
  detectThread(tabId: number): Promise<ThreadRef | null>;
  injectInput(tabId: number, text: string, opts?: { send?: boolean }): Promise<void>;
  observeAssistantTurns(tabId: number, cb: (turn: Turn) => void): Unsubscribe;
  detectCompletion(tabId: number): Promise<boolean>;
}
