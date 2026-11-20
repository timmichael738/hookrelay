import { buildApp } from './app.js';

const app = await buildApp({
  publicUrl: process.env.PUBLIC_URL,
  maxBodyBytes: process.env.MAX_BODY_BYTES ? Number(process.env.MAX_BODY_BYTES) : undefined,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 4000) });
