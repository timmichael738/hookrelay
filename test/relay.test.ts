import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openTunnel, type DeliveryEvent, type Tunnel } from '../src/cli/tunnel.js';
import { buildApp } from '../src/server/app.js';

type App = Awaited<ReturnType<typeof buildApp>>;

let relay: App;
let relayUrl: string;
let local: FastifyInstance;
let localUrl: string;
const received: { method: string; url: string; body: unknown; headers: Record<string, unknown> }[] =
  [];

async function createEndpoint() {
  const res = await relay.inject({ method: 'POST', url: '/api/endpoints' });
  return res.json() as { slug: string; token: string; url: string; inspectUrl: string };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeAll(async () => {
  relay = await buildApp({ logger: false, tunnelTimeoutMs: 1000 });
  relayUrl = await relay.listen({ port: 0, host: '127.0.0.1' });

  local = Fastify();
  local.all('/*', async (request, reply) => {
    received.push({
      method: request.method,
      url: request.url,
      body: request.body,
      headers: request.headers,
    });
    if (request.url.startsWith('/fail')) return reply.code(500).send({ error: 'local bug' });
    return reply.header('x-local', 'yes').send({ handled: true });
  });
  localUrl = await local.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await relay.close();
  await local.close();
});

describe('endpoints & capture', () => {
  it('creates an endpoint with a secret token kept in the URL fragment', async () => {
    const endpoint = await createEndpoint();
    expect(endpoint.slug).toMatch(/^[a-f0-9]{12}$/);
    expect(endpoint.token).toMatch(/^hr_/);
    expect(endpoint.inspectUrl).toContain(`#token=${endpoint.token}`);
  });

  it('captures any method, path, query and raw body', async () => {
    const { slug, token } = await createEndpoint();
    const payload = '{"type":"invoice.paid","amount":4200}';
    const res = await relay.inject({
      method: 'POST',
      url: `/h/${slug}/stripe/events?live=false`,
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const listed = await relay.inject({
      url: `/api/endpoints/${slug}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const [captured] = listed.json().requests;
    expect(captured).toMatchObject({
      method: 'POST',
      path: '/stripe/events?live=false',
      contentType: 'application/json',
      size: payload.length,
    });
    expect(captured.headers['stripe-signature']).toBe('t=1,v1=abc');
    expect(Buffer.from(captured.body, 'base64').toString()).toBe(payload);
  });

  it('preserves binary bodies byte-for-byte', async () => {
    const { slug } = await createEndpoint();
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13]);
    await relay.inject({
      method: 'PUT',
      url: `/h/${slug}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    const [captured] = relay.store.list(slug);
    expect(Buffer.from(captured!.body, 'base64')).toEqual(bytes);
  });

  it('returns 404 for unknown endpoints', async () => {
    expect((await relay.inject({ method: 'POST', url: '/h/doesnotexist' })).statusCode).toBe(404);
  });

  it('requires the endpoint token for management APIs', async () => {
    const { slug } = await createEndpoint();
    const other = await createEndpoint();
    expect((await relay.inject({ url: `/api/endpoints/${slug}` })).statusCode).toBe(401);
    const wrongToken = await relay.inject({
      url: `/api/endpoints/${slug}`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(wrongToken.statusCode).toBe(401);
  });

  it('evicts the oldest requests beyond the per-endpoint cap', async () => {
    const small = await buildApp({ logger: false, store: { maxRequestsPerEndpoint: 3 } });
    const { slug } = (await small.inject({ method: 'POST', url: '/api/endpoints' })).json();
    for (let i = 0; i < 5; i++) await small.inject({ method: 'POST', url: `/h/${slug}/${i}` });
    expect(small.store.list(slug).map((r) => r.path)).toEqual(['/4', '/3', '/2']);
    await small.close();
  });
});

describe('CLI tunnel', () => {
  let tunnel: Tunnel | undefined;
  afterAll(() => tunnel?.close());

  it('forwards live webhooks to localhost and returns the real response', async () => {
    const { slug, token } = await createEndpoint();
    const deliveries: DeliveryEvent[] = [];
    let ready = false;
    tunnel = openTunnel({
      server: relayUrl,
      slug,
      token,
      target: localUrl,
      onReady: () => (ready = true),
      onRequest: (e) => deliveries.push(e),
    });
    await waitFor(() => ready && relay.tunnels.isConnected(slug));

    const res = await fetch(`${relayUrl}/h/${slug}/github?delivery=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-local')).toBe('yes');
    expect(await res.json()).toEqual({ handled: true });

    const hit = received.at(-1)!;
    expect(hit.url).toBe('/github?delivery=1');
    expect(hit.body).toEqual({ ref: 'refs/heads/main' });
    expect(hit.headers['x-github-event']).toBe('push');
    expect(deliveries.at(-1)).toMatchObject({ method: 'POST', status: 200, replay: false });

    // Delivery outcome is recorded on the captured request.
    await waitFor(() => relay.store.list(slug)[0]!.forwards.length === 1);
    expect(relay.store.list(slug)[0]!.forwards[0]!.status).toBe(200);

    // Replay re-delivers the same request through the tunnel.
    const id = relay.store.list(slug)[0]!.id;
    const replay = await fetch(`${relayUrl}/api/endpoints/${slug}/requests/${id}/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replay.status).toBe(200);
    expect(received.filter((r) => r.url === '/github?delivery=1')).toHaveLength(2);
    expect(deliveries.at(-1)!.replay).toBe(true);

    // Local errors are passed through faithfully.
    const failing = await fetch(`${relayUrl}/h/${slug}/fail`, { method: 'POST' });
    expect(failing.status).toBe(500);
  });

  it('refuses replay when no tunnel is connected', async () => {
    const { slug, token } = await createEndpoint();
    await relay.inject({ method: 'POST', url: `/h/${slug}` });
    const [captured] = relay.store.list(slug);
    const res = await relay.inject({
      method: 'POST',
      url: `/api/endpoints/${slug}/requests/${captured!.id}/replay`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects tunnel connections with a bad token', async () => {
    const { slug } = await createEndpoint();
    const t = openTunnel({ server: relayUrl, slug, token: 'hr_wrong', target: localUrl });
    await new Promise((r) => setTimeout(r, 200));
    expect(relay.tunnels.isConnected(slug)).toBe(false);
    t.close();
  });
});
