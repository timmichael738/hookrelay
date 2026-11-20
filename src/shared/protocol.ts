import { z } from 'zod';

/**
 * Messages exchanged over the tunnel WebSocket between the relay server and the CLI.
 * Bodies are base64 so binary payloads (e.g. signed webhook bodies) survive byte-for-byte.
 */
const headers = z.record(z.string(), z.string());

export const tunnelRequestSchema = z.object({
  type: z.literal('request'),
  id: z.string(),
  method: z.string(),
  /** Path after the endpoint prefix, including the query string, e.g. "/stripe?x=1". */
  path: z.string(),
  headers,
  body: z.string(),
  replay: z.boolean().default(false),
});

export const tunnelResponseSchema = z.object({
  type: z.literal('response'),
  id: z.string(),
  status: z.number().int().min(100).max(599),
  headers,
  body: z.string(),
  durationMs: z.number(),
});

export const tunnelErrorSchema = z.object({
  type: z.literal('error'),
  id: z.string(),
  message: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  tunnelRequestSchema,
  z.object({ type: z.literal('ready'), endpoint: z.string(), url: z.string() }),
]);

export const clientMessageSchema = z.discriminatedUnion('type', [
  tunnelResponseSchema,
  tunnelErrorSchema,
]);

export type TunnelRequest = z.infer<typeof tunnelRequestSchema>;
export type TunnelResponse = z.infer<typeof tunnelResponseSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Connection-level headers must not be copied between hops (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export function forwardableHeaders(
  input: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
