import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    build: {
      // Vendor splits keep React/charts out of the app entry; App.tsx itself remains a large SPA chunk.
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('react-dom') || id.includes(`${path.sep}react${path.sep}`) || id.includes('/react/')) {
              return 'vendor-react';
            }
            if (id.includes('motion') || id.includes('framer-motion')) {
              return 'vendor-framer';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (
              id.includes('recharts')
              || id.includes('echarts')
              || id.includes('lightweight-charts')
              || id.includes(`${path.sep}d3${path.sep}`)
              || id.includes('/d3/')
              || id.includes('d3-')
            ) {
              return 'vendor-charts';
            }
            if (id.includes('reactflow') || id.includes('@reactflow')) {
              return 'vendor-flow';
            }
          },
        },
      },
    },
  };
});
