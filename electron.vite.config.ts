/** electron-vite 统一构建配置：同时管理 Main / Preload / Renderer（支持开发期 HMR 与主进程热重启）。 */
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import path from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'electron/main.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'electron/preload.ts'),
          docPreload: path.resolve(__dirname, 'electron/doc/docPreload.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: __dirname,
    plugins: [react()],
    define: {
      __ORBIT_API_BASE__: JSON.stringify(
        process.env.VITE_ORBIT_API_BASE || process.env.ORBIT_API_BASE || '',
      ),
      __ORBIT_WS_URL__: JSON.stringify(
        process.env.VITE_ORBIT_WS_URL || process.env.ORBIT_WS_URL || '',
      ),
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'index.html'),
        },
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@shared': path.resolve(__dirname, 'src/shared'),
        react: path.resolve(__dirname, 'node_modules/react'),
        'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      },
    },
  },
});
