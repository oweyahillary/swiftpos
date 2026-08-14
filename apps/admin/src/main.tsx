import React from 'react';
import ReactDOM from 'react-dom/client';
import AdminPortal from './AdminPortal';
import { applyAppFlavor } from './lib/appFlavor';
import './index.css';

applyAppFlavor(); // A68: badge tab per deployment (VITE_APP_ENV), before render

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminPortal />
  </React.StrictMode>
);
