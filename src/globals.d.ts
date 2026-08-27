import 'react';

declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: any;
  }
}

declare global {
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
