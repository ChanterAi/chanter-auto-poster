import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PromptEvolverPage from './pages/PromptEvolverPage';

const root = document.getElementById('prompt-evolver-root');

if (root) {
  createRoot(root).render(
    <StrictMode>
      <PromptEvolverPage />
    </StrictMode>
  );
}
