import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import '@fontsource-variable/source-sans-3';
import './styles.css';
import App from './App';
import { listenForErrors } from './errors/reporter';
import { applyShopBrand } from './shop/brandTheme';
import { API_URL } from './config';

// The status bar must NOT overlay the web view (Android 15 draws edge-to-edge by default, so the screens' top bar ran
// under the clock and battery). A dark bar with light icons sits above the web view everywhere — the Shop POS header is
// always dark (#111827), and the app's own screens are dark too — so nothing overlaps and the icons stay readable.
async function setupStatusBar(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setBackgroundColor({ color: '#111827' });
    await StatusBar.setStyle({ style: Style.Dark });   // Style.Dark = light icons, for a dark background
  } catch { /* plugin missing or not Android: leave the system default */ }
}
void setupStatusBar();

// Till stage 1: the web POS screens find the cloud the way the dashboard is told at run time (apps/dashboard
// src/lib/config.ts, window.__SWIFTPOS_CONFIG__) — the same address as this app's own calls (config.ts).
(window as unknown as { __SWIFTPOS_CONFIG__?: { apiUrl?: string } }).__SWIFTPOS_CONFIG__ = { apiUrl: API_URL };

listenForErrors();

// Wear the client's brand colours on the shell from the first paint (cached at registration / each sign-in — brandTheme.ts).
applyShopBrand();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
