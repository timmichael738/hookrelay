import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

export interface ForwardResult {
  status?: number;
  durationMs?: number;
  error?: string;
  at: string;
}

export interface CapturedRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Base64-encoded raw body. */
  body: string;
  size: number;
  contentType: string | null;
  ip: string;
  receivedAt: string;
  forwards: ForwardResult[];
}

interface Endpoint {
  slug: string;
  tokenDigest: Buffer;
  createdAt: number;
  lastActivity: number;
  requests: CapturedRequest[];
}

export interface StoreOptions {
  /** Requests kept per endpoint (oldest are evicted first). */
  maxRequestsPerEndpoint?: number;
  maxEndpoints?: number;
  /** Endpoints with no activity for this long are deleted. */
  idleTtlMs?: number;
  now?: () => number;
}

export type StoreEvent =
  { type: 'request'; request: CapturedRequest } | { type: 'update'; request: CapturedRequest };

const digest = (token: string) => createHash('sha256').update(token).digest();

/**
 * In-memory endpoint/request store. Webhook payloads are inherently ephemeral debugging data,
 * so bounded memory with eviction is the right default; the interface is small enough to
 * back with Redis or Postgres if persistence is needed.
 */
export class EndpointStore {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly events = new EventEmitter();
  private readonly opts: Required<StoreOptions>;

  constructor(options: StoreOptions = {}) {
    this.opts = {
      maxRequestsPerEndpoint: options.maxRequestsPerEndpoint ?? 100,
      maxEndpoints: options.maxEndpoints ?? 10_000,
      idleTtlMs: options.idleTtlMs ?? 24 * 60 * 60_000,
      now: options.now ?? Date.now,
    };
    this.events.setMaxListeners(0);
  }

  create(): { slug: string; token: string } {
    this.sweep();
    if (this.endpoints.size >= this.opts.maxEndpoints) {
      throw Object.assign(new Error('Endpoint limit reached'), { statusCode: 503 });
    }
    const slug = randomBytes(6).toString('hex');
    const token = `hr_${randomBytes(24).toString('base64url')}`;
    const now = this.opts.now();
    this.endpoints.set(slug, {
      slug,
      tokenDigest: digest(token),
      createdAt: now,
      lastActivity: now,
      requests: [],
    });
    return { slug, token };
  }

  exists(slug: string): boolean {
    return this.endpoints.has(slug);
  }

  /** Constant-time token check, so the token can't be guessed byte by byte from response timing. */
  authorize(slug: string, token: string | undefined): boolean {
    const endpoint = this.endpoints.get(slug);
    if (!endpoint || !token) return false;
    return timingSafeEqual(endpoint.tokenDigest, digest(token));
  }

  capture(slug: string, input: Omit<CapturedRequest, 'id' | 'receivedAt' | 'forwards'>) {
    const endpoint = this.endpoints.get(slug);
    if (!endpoint) return null;
    const request: CapturedRequest = {
      ...input,
      id: randomUUID(),
      receivedAt: new Date(this.opts.now()).toISOString(),
      forwards: [],
    };
    endpoint.requests.unshift(request);
    endpoint.requests.length = Math.min(endpoint.requests.length, this.opts.maxRequestsPerEndpoint);
    endpoint.lastActivity = this.opts.now();
    this.events.emit(slug, { type: 'request', request } satisfies StoreEvent);
    return request;
  }

  recordForward(slug: string, id: string, result: Omit<ForwardResult, 'at'>): void {
    const request = this.get(slug, id);
    if (!request) return;
    request.forwards.push({ ...result, at: new Date(this.opts.now()).toISOString() });
    this.events.emit(slug, { type: 'update', request } satisfies StoreEvent);
  }

  list(slug: string): CapturedRequest[] {
    return this.endpoints.get(slug)?.requests ?? [];
  }

  get(slug: string, id: string): CapturedRequest | undefined {
    return this.endpoints.get(slug)?.requests.find((r) => r.id === id);
  }

  clear(slug: string): void {
    const endpoint = this.endpoints.get(slug);
    if (endpoint) endpoint.requests = [];
  }

  delete(slug: string): boolean {
    return this.endpoints.delete(slug);
  }

  subscribe(slug: string, listener: (event: StoreEvent) => void): () => void {
    this.events.on(slug, listener);
    return () => this.events.off(slug, listener);
  }

  sweep(): number {
    const cutoff = this.opts.now() - this.opts.idleTtlMs;
    let removed = 0;
    for (const [slug, endpoint] of this.endpoints) {
      if (endpoint.lastActivity < cutoff) {
        this.endpoints.delete(slug);
        removed++;
      }
    }
    return removed;
  }
}
