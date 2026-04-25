import React, { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const readFixture = () => {
  const params = new URLSearchParams(location.search);
  return {
    provider: params.get('provider') ?? 'chatgpt',
    title: params.get('title') ?? 'Untitled thread',
    status: params.get('status') ?? 'active',
    lastSpeaker: params.get('lastSpeaker') ?? 'assistant',
  };
};

function ThreadFixture() {
  const fixture = useMemo(readFixture, []);
  return (
    <main className="fixtureShell" data-bac-thread-fixture>
      <p className="eyebrow">Thread fixture</p>
      <h1>{fixture.title}</h1>
      <dl>
        <div>
          <dt>Provider</dt>
          <dd>{fixture.provider}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{fixture.status}</dd>
        </div>
        <div>
          <dt>Last speaker</dt>
          <dd>{fixture.lastSpeaker}</dd>
        </div>
      </dl>
      <section aria-label="Fixture transcript">
        <p>User: Can you help me continue this research workstream?</p>
        <p>Assistant: Yes. I have enough context to keep the thread moving.</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThreadFixture />
  </React.StrictMode>,
);
