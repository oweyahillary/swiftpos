import type { CapacitorConfig } from '@capacitor/cli';

// ZapTill for Android (docs/ANDROID-APP-DESIGN.md). One app, two modes chosen at first launch.
const config: CapacitorConfig = {
  appId: 'com.zaptill.app',
  appName: 'ZapTill',
  webDir: 'dist',
  android: {
    // The app talks to the cloud through CapacitorHttp (src/cloud/client.ts), never the WebView's fetch: no CORS origin
    // to allow on the cloud, and the session header never meets a web origin.
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    // Till stage 1 (docs/ANDROID-APP-DESIGN.md §11.1): the web POS screens call the cloud with fetch(); with this, Capacitor
    // sends every fetch / XMLHttpRequest through the same native HTTP stack as src/cloud/client.ts — so the screens, as they
    // are, need no CORS entry for the app either.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
