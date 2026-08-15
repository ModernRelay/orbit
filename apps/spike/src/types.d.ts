import type { SpikeApi } from './main';

declare global {
  interface Window {
    __spike: SpikeApi;
  }
}

export {};
