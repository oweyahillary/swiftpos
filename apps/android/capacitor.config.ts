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
};

export default config;
