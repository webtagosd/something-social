// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  compressHTML: false,
  server: { port: 4381 },
  vite: {
    plugins: [tailwindcss()],
  },
});
