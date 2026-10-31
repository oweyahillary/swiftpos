import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';
import { applyAppFlavor } from './lib/appFlavor';
import './index.css';
import { stopWheelOnNumberInputs } from '@zaptill/ui/numberInputs';
import { RELEASE } from '@zaptill/core/release';
import { reloadForNewBuild } from './lib/staleBuild';
import { bootBrandTheme } from './lib/themeBoot';

stopWheelOnNumberInputs(document);

// A610: a tab from before a deploy asks for chunks that no longer exist — Vite reports the failed preload here; load the
// new build once (lib/staleBuild.ts) instead of a broken page. A failed lazy page itself is caught by ErrorBoundary.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});

applyAppFlavor(); // A68: badge tab per deployment (VITE_APP_ENV), before render
bootBrandTheme();   // A609: the shop's last look (colours + menu logo) before the first render

// A281: which commit is this web build? One line in the console so a front-end/
// back-end branch mismatch is a glance, not hours of diagnosis.
console.info(`[web] ZapTill v${RELEASE} dashboard build ${__WEB_BUILD_SHA__} (${__WEB_BUILD_REF__}) @ ${__WEB_BUILD_TIME__}`);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
