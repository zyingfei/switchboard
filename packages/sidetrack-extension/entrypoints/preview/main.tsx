import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Preview } from './Preview';
import '../sidepanel/style.css';

const container = document.getElementById('preview-root');
if (container === null) {
  throw new Error('Sidetrack preview root element missing.');
}

createRoot(container).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
