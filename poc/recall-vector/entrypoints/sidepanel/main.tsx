import ReactDOM from 'react-dom/client';
import { App } from './App';
import './style.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Could not find root container');
}

ReactDOM.createRoot(container).render(<App />);
