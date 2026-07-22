import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles/macintosh.css';

const root = document.getElementById('root');
if (!root) throw new Error('Macintosh Workbench could not find its renderer root.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
