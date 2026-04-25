import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../sidepanel/App';
import '../sidepanel/style.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Workspace root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <App surface="workspace" />
  </StrictMode>,
);
