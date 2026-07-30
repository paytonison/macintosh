import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { installMacintoshCursors } from './model/cursors';
import './styles/macintosh.css';

const root = document.getElementById('root');
if (!root) throw new Error('The Macintosh could not find its renderer root.');

installMacintoshCursors(document.documentElement.style);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
