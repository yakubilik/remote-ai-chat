import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setLang } from './lib/i18n';

// The panel's own copy is English. i18n is here for one job: the daemon tags
// every error it sends with a code, and this turns those codes into a sentence.
// (The phone is the bilingual client; its table is what src/lib/i18n.ts mirrors.)
setLang('en');

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
