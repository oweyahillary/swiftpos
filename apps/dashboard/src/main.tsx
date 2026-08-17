import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';
import { applyAppFlavor } from './lib/appFlavor';
import './index.css';

applyAppFlavor(); // A68: badge tab per deployment (VITE_APP_ENV), before render

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
