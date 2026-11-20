import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { forwardableHeaders } from '../shared/protocol.js';
import { EndpointStore, type StoreOptions } from './store.js';
import { TunnelRegistry } from './tunnels.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

export interface AppOptions {
  /** Externally reachable base URL, used to build webhook URLs. */
  publicUrl?: string;
  maxBodyBytes?: number;
  tunnelTimeoutMs?: number;
  store?: StoreOptions;
  logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyInstance {
    store: EndpointStore;
    tunnels: TunnelRegistry;
  }
}

type SlugParams = { slug: string };

export async function buildApp(options: AppOptions = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: maxBodyBytes,
    trustProxy: true,
  });
  const store = new EndpointStore(options.store);
  const tunnels = new TunnelRegistry(options.tunnelTimeoutMs);
  app.decorate('store', store);
  app.decorate('tunnels', tunnels);

  const baseUrl = (request: FastifyRequest) =>
    options.publicUrl ?? `${request.protocol}://${request.host}`;

  const sweeper = setInterval(() => store.sweep(), 60_000);
  sweeper.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    tunnels.closeAll();
  });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: PUBLIC_DIR, wildcard: false });

  // The inspector UI is a single page; /e/<slug> deep-links into an endpoint.
  app.get('/e/:slug', (_request, reply) => reply.sendFile('index.html'));
  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Every management route requires the endpoint's token (header, or ?token= for EventSource/WS). */
  const requireToken = async (
    request: FastifyRequest<{ Params: SlugParams }>,
    reply: FastifyReply,
  ) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : (request.query as { token?: string }).token;
    if (!store.authorize(request.params.slug, token)) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid endpoint or token' });
    }
  };

  app.post('/api/endpoints', async (request, reply) => {
    const { slug, token } = store.create();
    const base = baseUrl(request);
    return reply.code(201).send({
      slug,
      token,
      url: `${base}/h/${slug}`,
      // Token travels in the URL fragment, which browsers never send to the server.
      inspectUrl: `${base}/e/${slug}#token=${token}`,
    });
  });

  app.register(async (api) => {
    api.addHook('preHandler', requireToken);

    api.get<{ Params: SlugParams }>('/api/endpoints/:slug', async (request) => ({
      slug: request.params.slug,
      url: `${baseUrl(request)}/h/${request.params.slug}`,
      tunnelConnected: tunnels.isConnected(request.params.slug),
      requests: store.list(request.params.slug),
    }));

    api.delete<{ Params: SlugParams }>('/api/endpoints/:slug/requests', async (request, reply) => {
      store.clear(request.params.slug);
      return reply.code(204).send();
    });

    api.delete<{ Params: SlugParams }>('/api/endpoints/:slug', async (request, reply) => {
      store.delete(request.params.slug);
      return reply.code(204).send();
    });

    /** Server-Sent Events: the UI gets new requests and forward results live. */
    api.get<{ Params: SlugParams }>('/api/endpoints/:slug/events', (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown) =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const status = () => send('tunnel', { connected: tunnels.isConnected(request.params.slug) });

      status();
      const unsubscribe = store.subscribe(request.params.slug, (e) => send(e.type, e.request));
      const heartbeat = setInterval(status, 15_000);
      request.raw.on('close', () => {
        unsubscribe();
        clearInterval(heartbeat);
      });
    });

    /**
     * Replay re-delivers a captured request through the CLI tunnel to the developer's machine.
     * The server never makes outbound requests to user-supplied URLs, so there's no SSRF surface.
     */
    api.post<{ Params: SlugParams & { id: string } }>(
      '/api/endpoints/:slug/requests/:id/replay',
      async (request, reply) => {
        const { slug, id } = request.params;
        const captured = store.get(slug, id);
        if (!captured) return reply.code(404).send({ error: 'Request not found' });
        try {
          const response = await tunnels.forward(slug, {
            method: captured.method,
            path: captured.path,
            headers: captured.headers,
            body: captured.body,
            replay: true,
          });
          store.recordForward(slug, id, {
            status: response.status,
            durationMs: response.durationMs,
          });
          return { status: response.status, durationMs: response.durationMs };
        } catch (error) {
          const message = (error as Error).message;
          store.recordForward(slug, id, { error: message });
          return reply.code(409).send({ error: 'Replay failed', message });
        }
      },
    );

    api.get<{ Params: SlugParams }>(
      '/api/endpoints/:slug/tunnel',
      { websocket: true },
      (socket, request) => {
        const { slug } = request.params;
        tunnels.attach(slug, socket, {
          type: 'ready',
          endpoint: slug,
          url: `${baseUrl(request)}/h/${slug}`,
        });
        request.log.info({ slug }, 'tunnel connected');
      },
    );
  });

  /** Webhook ingress: accept any method, any content type, capture raw bytes. */
  app.register(async (ingress) => {
    ingress.removeAllContentTypeParsers();
    ingress.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );

    const capture = async (
      request: FastifyRequest<{ Params: SlugParams & { '*'?: string } }>,
      reply: FastifyReply,
    ) => {
      const { slug } = request.params;
      const subPath = request.params['*'] ? `/${request.params['*']}` : '/';
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const headers = forwardableHeaders(request.headers);

      const captured = store.capture(slug, {
        method: request.method,
        path: subPath + query,
        headers,
        body: body.toString('base64'),
        size: body.length,
        contentType: request.headers['content-type'] ?? null,
        ip: request.ip,
      });
      if (!captured) return reply.code(404).send({ error: 'Unknown endpoint' });

      if (!tunnels.isConnected(slug)) {
        return reply.code(200).send({ ok: true, id: captured.id });
      }

      // Live tunnel: the webhook sender receives the local server's real response.
      try {
        const response = await tunnels.forward(slug, {
          method: captured.method,
          path: captured.path,
          headers,
          body: captured.body,
          replay: false,
        });
        store.recordForward(slug, captured.id, {
          status: response.status,
          durationMs: response.durationMs,
        });
        return reply
          .code(response.status)
          .headers(forwardableHeaders(response.headers))
          .send(Buffer.from(response.body, 'base64'));
      } catch (error) {
        const message = (error as Error).message;
        store.recordForward(slug, captured.id, { error: message });
        const timedOut = message.includes('did not respond');
        return reply.code(timedOut ? 504 : 502).send({ error: message });
      }
    };

    ingress.all('/h/:slug', capture);
    ingress.all('/h/:slug/*', capture);
  });

  return app;
}
