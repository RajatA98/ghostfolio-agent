import { defineConfig } from 'vite';

const agentPort = '3334';

export default defineConfig({
  root: 'src/client',
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${agentPort}`,
      '/health': `http://127.0.0.1:${agentPort}`
    }
  },
  build: {
    outDir: '../../dist/client'
  }
});
