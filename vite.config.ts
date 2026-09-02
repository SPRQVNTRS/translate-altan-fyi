import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const hmrPort = env.HMR_PORT ? parseInt(env.HMR_PORT, 10) : 24678;
  const serverPort = env.PORT ? parseInt(env.PORT, 10) : 3000;

  return {
    plugins: [tailwindcss(), reactRouter()],
    resolve: {
      tsconfigPaths: true,
    },
    server: {
      port: serverPort,
      hmr: { port: hmrPort },
    },
  };
});
