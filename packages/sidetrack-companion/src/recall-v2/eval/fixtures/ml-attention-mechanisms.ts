// Grounded — ML topic. Selection: "attention mechanisms in transformer
// models". URLs verified against the test vault on 2026-05-24.
//
// Embedding axes — axis 3 = ML/transformer/LLM; axis 6 = education/
// learning (drift); axis 1 = graph algorithm (Bellman-Ford).

import type { Fixture } from '../harness.js';

export const fixture: Fixture = {
  name: 'ml-attention-mechanisms',
  description:
    'Grounded — ML/transformer selection should surface LLM scratch-build resources; must NOT surface generic-learning audiobooks or graph-algorithm wiki.',
  selectionText: 'attention mechanisms in transformer models',
  selectionEmbedding: [0, 0, 0, 1, 0, 0, 0, 0],
  currentUrl: 'https://github.com/rasbt/LLMs-from-scratch',
  docs: [
    {
      url: 'https://www.manning.com/books/build-a-large-language-model-from-scratch',
      title: 'Build a Large Language Model (From Scratch) - Sebastian Raschka',
      body:
        'Build a transformer-based LLM from scratch. Implement attention mechanisms, ' +
        'multi-head attention, feed-forward layers, and pre-training.',
      embedding: [0, 0, 0, 0.95, 0, 0, 0.05, 0],
    },
    {
      url: 'https://github.com/rasbt/reasoning-from-scratch',
      title: 'Implement a reasoning LLM in PyTorch from scratch, step by step',
      body: 'PyTorch implementation of attention mechanisms and reasoning LLM. Step-by-step.',
      embedding: [0, 0, 0, 0.92, 0, 0, 0.05, 0],
    },
    {
      url: 'https://github.com/huggingface/transformers',
      title: 'Transformers: the model-definition framework for state-of-the-art machine learning',
      body: 'Hugging Face Transformers library. Pretrained transformer models, attention.',
      embedding: [0, 0, 0, 0.9, 0, 0, 0.1, 0],
    },
    {
      url: 'https://www.youtube.com/watch?v=quh7z1q7-uc',
      title: 'Building LLMs from the Ground Up: A 3-hour Coding Workshop',
      body: 'Workshop on building LLMs from scratch. Attention mechanisms, transformer architecture.',
      embedding: [0, 0, 0, 0.88, 0, 0, 0.1, 0],
    },
    {
      url: 'https://cs336.stanford.edu',
      title: 'Stanford CS336 | Language Modeling from Scratch',
      body: 'Stanford course on language modeling. Transformers, attention, scaling.',
      embedding: [0, 0, 0, 0.85, 0, 0, 0.15, 0],
    },
    {
      url: 'https://arxiv.org/html/2505.11329v1',
      title: 'TokenWeave: Efficient Compute-Communication Overlap for Distributed LLM Inference',
      body: 'Distributed LLM inference. Communication overlap, transformer parallelism.',
      embedding: [0, 0, 0, 0.7, 0, 0, 0, 0],
    },
    // forbidden
    {
      url: 'https://en.wikipedia.org/wiki/Bellman%E2%80%93Ford_algorithm',
      title: 'Bellman–Ford algorithm - Wikipedia',
      body:
        'The Bellman–Ford algorithm computes shortest paths in a weighted digraph. ' +
        'A classic graph algorithm.',
      embedding: [0, 0, 0, 0, 0, 0, 0, 0.95],
    },
    {
      url: 'https://www.audible.com/pd/Building-a-Better-Vocabulary-Audiobook/B00SJIVE3W',
      title: 'Building a Better Vocabulary Audiobook',
      body:
        'Build vocabulary through learning. Audiobook for English language learners. ' +
        'Educational content for word mastery.',
      embedding: [0, 0, 0, 0, 0, 0, 0.95, 0],
    },
    {
      url: 'https://www.audible.com/cat/Personal-Development/Communication-Social-Skills-Audiobooks',
      title: 'Communication & Social Skills Audiobooks',
      body: 'Audiobooks on social skills, communication, learning. Personal development.',
      embedding: [0, 0, 0, 0, 0, 0, 0.92, 0],
    },
  ],
  expected: {
    mustInclude: [
      'https://www.manning.com/books/build-a-large-language-model-from-scratch',
      'https://github.com/rasbt/reasoning-from-scratch',
      'https://github.com/huggingface/transformers',
      'https://www.youtube.com/watch?v=quh7z1q7-uc',
      'https://cs336.stanford.edu',
    ],
    shouldInclude: ['https://arxiv.org/html/2505.11329v1'],
    forbidden: [
      'https://en.wikipedia.org/wiki/Bellman%E2%80%93Ford_algorithm',
      'https://www.audible.com/pd/Building-a-Better-Vocabulary-Audiobook/B00SJIVE3W',
      'https://www.audible.com/cat/Personal-Development/Communication-Social-Skills-Audiobooks',
    ],
  },
  assertions: {
    recallAtK: 5,
    minRecall: 0.4,
    minNdcg: 0.5,
    minMrr: 0.5,
    maxForbiddenRate: 0.0,
    minSourceDiversity: 1,
  },
};
