import WebSocket from 'ws';
import {
  forwardableHeaders,
  serverMessageSchema,
  type ClientMessage,
  type TunnelRequest,
} from '../shared/protocol.js';

export interface TunnelOptions {
  server: string;
  slug: string;
  token: string;
  /** Local base URL requests are delivered to, e.g. http://localhost:3000/webhooks */
  target: string;
  onReady?: (url: string) => void;
  onRequest?: (event: DeliveryEvent) => void;
  onDisconnect?: (retryInMs: number) => void;
}

export interface DeliveryEvent {
  method: string;
  path: string;
  status?: number;
  durationMs: number;
  error?: string;
  replay: boolean;
}

export interface Tunnel {
  close(): void;
}

/** Deliver one tunnelled request to the local target and build the reply message. */
export async function deliver(target: string, request: TunnelRequest): Promise<ClientMessage> {
  const started = performance.now();
  const url = target.replace(/\/$/, '') + request.path;
  try {
    const hasBody = !['GET', 'HEAD'].includes(request.method.toUpperCase());
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? Buffer.from(request.body, 'base64') : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      type: 'response',
      id: request.id,
      status: response.status,
      headers: forwardableHeaders(Object.fromEntries(response.headers)),
      body: body.toString('base64'),
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    const cause = (error as Error & { cause?: Error }).cause;
    return {
      type: 'error',
      id: request.id,
      message: `Could not reach ${url}: ${cause?.message ?? (error as Error).message}`,
    };
  }
}

/**
 * Opens a persistent tunnel. Reconnects with capped exponential backoff, so the CLI
 * survives server restarts and laptop sleep without the developer noticing.
 */
export function openTunnel(options: TunnelOptions): Tunnel {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;

  const wsUrl = `${options.server.replace(/^http/, 'ws').replace(/\/$/, '')}/api/endpoints/${options.slug}/tunnel`;

  const connect = () => {
    socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${options.token}` } });

    socket.on('message', async (raw) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === 'ready') {
        attempt = 0;
        options.onReady?.(message.url);
        return;
      }
      const reply = await deliver(options.target, message);
      options.onRequest?.({
        method: message.method,
        path: message.path,
        replay: message.replay,
        status: reply.type === 'response' ? reply.status : undefined,
        durationMs: reply.type === 'response' ? reply.durationMs : 0,
        error: reply.type === 'error' ? reply.message : undefined,
      });
      socket?.send(JSON.stringify(reply));
    });

    socket.on('close', (code) => {
      if (closed) return;
      if (code === 4000) {
        closed = true; // another CLI took over this endpoint
        return;
      }
      const delay = Math.min(30_000, 500 * 2 ** attempt++);
      options.onDisconnect?.(delay);
      retryTimer = setTimeout(connect, delay);
    });

    socket.on('error', () => {
      /* 'close' follows and handles reconnection */
    });
  };

  connect();

  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
