/// <reference types="vite/client" />

declare const __BUILD__: string;

declare module '*.wgsl?raw' {
  const src: string;
  export default src;
}
