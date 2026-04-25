import type { MockChatProvider } from './mockChatAdapter';
import type { SearchProvider } from './searchAdapter';

export type ForkProvider = MockChatProvider | SearchProvider;
