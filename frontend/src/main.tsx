import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppProvider } from './state/AppContext';
import { TagVocabProvider } from './state/TagVocabContext';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <AppProvider>
          <TagVocabProvider>
            <App />
          </TagVocabProvider>
        </AppProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
