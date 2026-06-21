import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AutoPosterDashboard from './pages/AutoPosterDashboard';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AutoPosterDashboard />
  </StrictMode>
);
