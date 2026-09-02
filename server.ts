import { createRequestHandler } from '@react-router/express';
import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { createServerLogger } from '@sprqvntrs/logger/server';
import { createHttpLogger } from '@sprqvntrs/logger/http';
import { initializeWorkflows, stopOrchestrator } from '#app/services/workflows.server';
import { closePool, poolInitialized } from '#drizzle/db';
import { reportError } from '#app/lib/report-error';
import { apiJsonMiddleware } from '#app/lib/api-middleware.server';
import { CONFIG } from '#app/config';

const { logger, logServerStart, logShutdown, logServerClosed } = createServerLogger({
  serviceName: 'translate-altan-fyi',
  registerGlobalHandlers: true,
  pretty: process.env.NODE_ENV !== 'production',
});

if (process.env.NODE_ENV === 'production' && !process.env.APP_URL) {
  throw new Error('APP_URL is not set');
}

const viteDevServer =
  process.env.NODE_ENV === 'production' ?
    undefined
  : await import('vite').then((vite) =>
      vite.createServer({
        server: { middlewareMode: true },
      }),
    );

// handle SSR requests

const remixHandler = createRequestHandler({
  build:
    viteDevServer ?
      () => viteDevServer.ssrLoadModule('virtual:react-router/server-build')
      // @ts-expect-error this file is generated at build time and relative to build directory
      // eslint-disable-next-line import/no-unresolved
    : await import('#build/server/index.js'),
});

const app = express();
// Trust the reverse proxy (Traefik) so req.protocol/req.hostname/req.ip and the
// URL the @react-router/express adapter builds reflect X-Forwarded-* headers.
// Required in v8: the CSRF check compares the browser Origin against request.url's
// host, so behind a proxy this must be enabled or same-origin actions get aborted.
// Configurable via TRUST_PROXY (default: 1 in production, off in dev). See app/config.
app.set('trust proxy', CONFIG.server.trustProxy);
app.use(compression());
app.disable('x-powered-by');

// handle asset requests
if (viteDevServer) {
  app.use(viteDevServer.middlewares);
} else {
  app.use(
    '/assets',
    express.static('build/client/assets', {
      immutable: true,
      maxAge: '1y',
    }),
  );
}

const httpLogger = createHttpLogger({
  logger,
  excludePaths: ['/healthcheck', '/__manifest', '/bullboard'],
  excludeExtensions: ['.ts', '.tsx', '.css', '.js', '.json', '.data', '.ico', '.png', '.svg'],
});

app.use(httpLogger);

// API JSON gate: ensure /api/v1/* responses are always JSON, never HTML
// redirects from session-based auth. Must run before remixHandler.
app.use(apiJsonMiddleware);

// Remix fingerprints its assets so we can cache forever.

app.use(express.static('build/client', { maxAge: '1h' }));

// Wait for the DB pool's retry-backed init to finish before starting pg-boss —
// pg-boss opens its own postgres connection in initializeWorkflows() and does
// not consult connectWithRetry's retry loop.
await poolInitialized;

// Initialize workflow orchestrator (worker runs separately via worker.ts)
await initializeWorkflows();

// handle SSR requests
app.all('*', remixHandler);

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  logServerStart(Number(port), { url: `http://localhost:${port}` });
});

// Graceful shutdown
// Timeline: SIGTERM → app cleanup (0-8s) → force exit (8s) → Docker SIGKILL (10s)
const FORCE_EXIT_TIMEOUT_MS = 8_000;
const CONNECTION_DRAIN_TIMEOUT_MS = 5_000;
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, ignoring duplicate signal', { signal });
    return;
  }
  isShuttingDown = true;
  logShutdown(signal);

  // Force exit safety net — fires before Docker's SIGKILL
  const forceExitTimer = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    // 1. Stop accepting new connections and drain idle keep-alive connections
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server.closeIdleConnections();

    // Force-close remaining connections after grace period
    const drainTimer = setTimeout(() => {
      logger.warn('Forcing remaining connections closed');
      server.closeAllConnections();
    }, CONNECTION_DRAIN_TIMEOUT_MS);
    drainTimer.unref();

    // 2. Stop orchestrator (pg-boss holds its own DB connection)
    await stopOrchestrator();

    // 3. Close Vite dev server in development
    if (viteDevServer) {
      await viteDevServer.close();
    }

    // 4. Close database pool (also clears stats interval)
    await closePool();

    clearTimeout(drainTimer);
    logServerClosed();
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err instanceof Error ? err : String(err) });
    reportError(err, { source: 'server-shutdown' });
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Mirror createServerLogger's global handlers (registerGlobalHandlers: true) into
// the reportError seam so consumer telemetry (Sentry/Datadog/etc.) sees these
// process-level errors. The logger's own pino handlers stay in place.
process.on('uncaughtException', (error) => {
  reportError(error, { source: 'server-uncaught' });
});
process.on('unhandledRejection', (reason) => {
  reportError(reason, { source: 'server-unhandled-rejection' });
});
