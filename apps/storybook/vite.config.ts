import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Storybook CLI owns the dev server (port/open); builder-vite auto-merges
// this config. If a dual-React "invalid hook call" ever appears after version
// drift, add `resolve: { dedupe: ['react', 'react-dom'] }` here.
export default defineConfig({
  plugins: [react()],
});
