/// <reference types="vite/client" />
import type { OrbitBridge } from './shared/ipc';

declare global {
  interface Window {
    orbit?: OrbitBridge;
  }
}
