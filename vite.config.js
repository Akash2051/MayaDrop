import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 5175 },
  build: { outDir: 'dist', sourcemap: true }
});
