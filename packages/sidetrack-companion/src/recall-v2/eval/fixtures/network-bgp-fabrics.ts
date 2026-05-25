// Grounded — network topic. Selection on a Facebook data-center
// fabric page should surface other DC network resources; must NOT
// surface academic social networks or AI inference HW.

import type { Fixture } from '../harness.js';

export const fixture: Fixture = {
  name: 'network-bgp-fabrics',
  description:
    'Grounded — BGP/datacenter selection should surface other DC network resources; must NOT surface academic social networks or AI inference HW.',
  selectionText: 'BGP routing convergence time in data center fabrics',
  selectionEmbedding: [0, 1, 0, 0, 0, 0, 0, 0],
  currentUrl:
    'https://engineering.fb.com/2014/11/14/production-engineering/introducing-data-center-fabric-the-next-generation-facebook-data-center-network',
  docs: [
    // The current_url itself — should be DROPPED from results.
    {
      url:
        'https://engineering.fb.com/2014/11/14/production-engineering/introducing-data-center-fabric-the-next-generation-facebook-data-center-network',
      title: 'Introducing data center fabric, the next-generation Facebook data center network',
      body: "Facebook's data center fabric architecture. BGP routing in the fabric.",
      embedding: [0, 0.95, 0, 0, 0, 0, 0, 0],
    },
    {
      url: 'https://engineering.fb.com/2019/03/14/data-center-engineering/f16-minipack',
      title: 'Reinventing our data center network with F16, Minipack',
      body: 'F16 fabric, Minipack hardware. BGP convergence improvements in the data center.',
      embedding: [0, 0.93, 0, 0, 0, 0, 0, 0],
    },
    {
      url:
        'https://www.reddit.com/r/networking/comments/2mbmys/facebooks_new_data_center_network_architecture',
      title: "Facebook's new data center network architecture : r/networking",
      body: 'Reddit thread discussing FB data center network. BGP, fabric, convergence.',
      embedding: [0, 0.9, 0, 0, 0, 0, 0, 0],
    },
    {
      url: 'https://gemini.google.com/app/988bb7ac2c6e0132',
      title: "Facebook's Data Center Network Evolution",
      body: 'Gemini chat about FB data center network evolution and BGP.',
      embedding: [0, 0.85, 0, 0, 0, 0, 0, 0],
    },
    {
      url: 'https://duckdb.org/2026/05/12/quack-remote-protocol',
      title: 'Quack: The DuckDB Client-Server Protocol – DuckDB',
      body: 'DuckDB remote protocol. Latency considerations for client-server queries.',
      embedding: [0, 0.5, 0, 0, 0, 0, 0, 0.3],
    },
    {
      url: 'https://www.infoq.com/presentations/LMAX',
      title: 'LMAX - How to Do 100K TPS at Less than 1ms Latency',
      body: 'LMAX low-latency architecture. 100K TPS. Networking and concurrency.',
      embedding: [0, 0.6, 0, 0, 0, 0, 0, 0.2],
    },
    {
      url: 'https://en.wikipedia.org/wiki/Latency_(engineering)',
      title: 'Latency (engineering) - Wikipedia',
      body: 'Engineering definition of latency. Network latency, system latency.',
      embedding: [0, 0.55, 0, 0, 0, 0, 0, 0.2],
    },
    // forbidden — drift
    {
      url: 'https://andreaturchet.github.io/website/',
      title: 'The Social Network for Researchers (Papel)',
      body: 'Academic social network for researchers. Profiles, papers, collaborations.',
      embedding: [0, 0, 0, 0, 0, 0, 0, 0.95],
    },
    {
      url: 'https://github.com/cactus-compute/cactus',
      title: 'Low-latency AI engine for mobile devices',
      body: 'Mobile AI inference engine. Low-latency on-device LLM execution.',
      embedding: [0.5, 0, 0, 0.3, 0, 0, 0, 0.3],
    },
  ],
  expected: {
    mustInclude: [
      'https://engineering.fb.com/2019/03/14/data-center-engineering/f16-minipack',
      'https://www.reddit.com/r/networking/comments/2mbmys/facebooks_new_data_center_network_architecture',
      'https://gemini.google.com/app/988bb7ac2c6e0132',
    ],
    shouldInclude: [
      'https://duckdb.org/2026/05/12/quack-remote-protocol',
      'https://www.infoq.com/presentations/LMAX',
      'https://en.wikipedia.org/wiki/Latency_(engineering)',
    ],
    forbidden: [
      'https://andreaturchet.github.io/website/',
      'https://github.com/cactus-compute/cactus',
    ],
  },
  assertions: {
    recallAtK: 5,
    minRecall: 0.5,
    minNdcg: 0.5,
    maxForbiddenRate: 0.0,
    minSourceDiversity: 1,
    currentUrlDropped: true,
  },
};
