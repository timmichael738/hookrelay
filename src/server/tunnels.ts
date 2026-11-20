import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  clientMessageSchema,
  type ServerMessage,
  type TunnelRequest,
  type TunnelResponse,
} from '../shared/protocol.js';

interface Pending {
  resolve: (response: TunnelResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Tracks one CLI tunnel per endpoint and correlates request/response pairs by id,
 * turning the WebSocket's message stream into simple awaitable calls.
 */
export class TunnelRegistry {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 15_000) {}

  attach(slug: string, socket: WebSocket, readyMessage: ServerMessage): void {
    // A newer CLI session takes over the endpoint, like re-running `ngrok`.
    this.sockets.get(slug)?.close(4000, 'Replaced by a newer tunnel connection');
    this.sockets.set(slug, socket);

    socket.on('message', (raw) => {
      const parsed = clientMessageSchema.safeParse(safeJson(raw.toString()));
      if (!parsed.success) return;
      const message = parsed.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'response') pending.resolve(message);
      else pending.reject(new Error(message.message));
    });

    socket.on('close', () => {
      if (this.sockets.get(slug) === socket) this.sockets.delete(slug);
    });

    socket.send(JSON.stringify(readyMessage));
  }

  isConnected(slug: string): boolean {
    return this.sockets.get(slug)?.readyState === 1; // OPEN
  }

  /** Send a request through the tunnel and wait for the local server's response. */
  forward(slug: string, request: Omit<TunnelRequest, 'type' | 'id'>): Promise<TunnelResponse> {
    const socket = this.sockets.get(slug);
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error('No tunnel connected for this endpoint'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tunnel did not respond within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message: TunnelRequest = { type: 'request', id, ...request };
      socket.send(JSON.stringify(message));
    });
  }

  closeAll(): void {
    for (const socket of this.sockets.values()) socket.close(1001, 'Server shutting down');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server shutting down'));
    }
    this.sockets.clear();
    this.pending.clear();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
