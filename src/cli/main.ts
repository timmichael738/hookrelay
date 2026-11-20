#!/usr/bin/env node
import { parseArgs, styleText } from 'node:util';
import { openTunnel } from './tunnel.js';

const HELP = `
hookrelay — receive webhooks on localhost

Usage
  hookrelay listen <port|url> [options]

Options
  -s, --server <url>     Relay server (default: $HOOKRELAY_SERVER or http://localhost:4000)
  -e, --endpoint <slug>  Reuse an existing endpoint (requires --token)
  -t, --token <token>    Endpoint token (default: $HOOKRELAY_TOKEN)
  -h, --help             Show this help

Examples
  hookrelay listen 3000
  hookrelay listen http://localhost:8080/api/webhooks
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: 'string', short: 's' },
    endpoint: { type: 'string', short: 'e' },
    token: { type: 'string', short: 't' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, targetArg] = positionals;
if (values.help || command !== 'listen' || !targetArg) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const server = (values.server ?? process.env.HOOKRELAY_SERVER ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);
const target = /^\d+$/.test(targetArg) ? `http://localhost:${targetArg}` : targetArg;

let slug = values.endpoint;
let token = values.token ?? process.env.HOOKRELAY_TOKEN;
let inspectUrl: string | undefined;

if (!slug || !token) {
  const res = await fetch(`${server}/api/endpoints`, { method: 'POST' }).catch((error: Error) => {
    console.error(styleText('red', `✖ Could not reach relay server ${server}: ${error.message}`));
    process.exit(1);
  });
  if (!res.ok) {
    console.error(styleText('red', `✖ Failed to create endpoint (HTTP ${res.status})`));
    process.exit(1);
  }
  const created = (await res.json()) as { slug: string; token: string; inspectUrl: string };
  ({ slug, token, inspectUrl } = created);
}

const statusColor = (status?: number) =>
  status === undefined
    ? 'red'
    : status < 300
      ? 'green'
      : status < 400
        ? 'cyan'
        : status < 500
          ? 'yellow'
          : 'red';

const tunnel = openTunnel({
  server,
  slug,
  token,
  target,
  onReady: (url) => {
    console.log(`\n${styleText('bold', 'hookrelay')} ${styleText('green', '● online')}\n`);
    console.log(`  Webhook URL   ${styleText('cyan', url)}`);
    console.log(`  Forwarding to ${target}`);
    if (inspectUrl) console.log(`  Inspector     ${inspectUrl}`);
    console.log(
      styleText('dim', `\n  Reconnect later with: --endpoint ${slug} --token ${token}\n`),
    );
  },
  onRequest: ({ method, path, status, durationMs, error, replay }) => {
    const time = new Date().toLocaleTimeString();
    const tag = replay ? styleText('magenta', ' replay') : '';
    const outcome = error
      ? styleText('red', `✖ ${error}`)
      : `${styleText(statusColor(status), String(status))} ${styleText('dim', `${durationMs}ms`)}`;
    console.log(
      `${styleText('dim', time)}${tag} ${styleText('bold', method.padEnd(6))} ${path} → ${outcome}`,
    );
  },
  onDisconnect: (ms) =>
    console.log(styleText('yellow', `⚠ Disconnected, retrying in ${ms / 1000}s…`)),
});

process.once('SIGINT', () => {
  tunnel.close();
  process.exit(0);
});
