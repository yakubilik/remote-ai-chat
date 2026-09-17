import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The daemon serves the built files itself, from
// daemon/remote_ai_chat/webui/. Relative base so it works whether the panel is
// opened at http://127.0.0.1:8790/ or through a Tailscale name.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../daemon/remote_ai_chat/webui',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5177,
    strictPort: true,
  },
});
