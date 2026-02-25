import { defineConfig } from 'vite';

const agentPort = process.env.PORT || '3334';

export default defineConfig({
  root: 'src/client',
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${agentPort}`,
      '/health': `http://localhost:${agentPort}`
    }
  },
  build: {
    outDir: '../../dist/client'
  }
});
