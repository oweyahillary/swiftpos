import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/source-sans-3';
import './styles.css';
import App from './App';
import { listenForErrors } from './errors/reporter';
import { API_URL } from './config';

// Till stage 1: the web POS screens find the cloud the way the dashboard is told at run time (apps/dashboard
// src/lib/config.ts, window.__SWIFTPOS_CONFIG__) — the same address as this app's own calls (config.ts).
(window as unknown as { __SWIFTPOS_CONFIG__?: { apiUrl?: string } }).__SWIFTPOS_CONFIG__ = { apiUrl: API_URL };

listenForErrors();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
