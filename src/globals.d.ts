import 'react';

declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: any;
  }
}

declare global {
  // Vite `define` literal (vite.config.js) - "stable" or "canary" depending
  // on the build mode. Dead-code-eliminated to nothing in a stable build.
  const __XENITH_CHANNEL__: string;

  interface Window {
    PluginApi: {
      React: any;
      ReactDOM: any;
      [key: string]: any;
    };
    __xenithCleanup?: () => void;
    __xenithLoaded?: boolean;
  }
}
