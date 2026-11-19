import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@lec-space/liquidglass/styles.css';
import './styles/global.css';
import { App } from './app/App';
import { OrbitErrorBoundary } from './app/OrbitErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OrbitErrorBoundary>
      <App />
    </OrbitErrorBoundary>
  </StrictMode>,
);
