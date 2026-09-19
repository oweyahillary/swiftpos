import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';
import { applyAppFlavor } from './lib/appFlavor';
import './index.css';

applyAppFlavor(); // A68: badge tab per deployment (VITE_APP_ENV), before render

// A281: which commit is this web build? One line in the console so a front-end/
// back-end branch mismatch is a glance, not hours of diagnosis.
console.info(`[web] SwiftPOS dashboard build ${__WEB_BUILD_SHA__} (${__WEB_BUILD_REF__}) @ ${__WEB_BUILD_TIME__}`);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
