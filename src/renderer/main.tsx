import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { installPixelCursors } from './model/cursors';
import './styles/macintosh.css';

installPixelCursors(document.documentElement.style);

const root = document.getElementById('root');
if (!root) throw new Error('The Macintosh could not find its renderer root.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
