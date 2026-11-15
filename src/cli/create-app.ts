// Creates runway's GitHub App from this machine (GitHub's manifest flow), so the stack needs no
// public page. A one-shot server on 127.0.0.1 serves a form that posts the manifest to GitHub;
// GitHub sends the browser back to it with a one-time code, which the CLI redeems for the App's
// credentials. The key goes from GitHub to this process to SSM, and nowhere else.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  convertManifestCode,
  createAppUrl,
  installUrl,
  manifest,
  type StoredApp,
} from '../core/app-manifest.js';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#0D1714;color:#E6F2ED;font:17px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:600px;padding:32px}h1{font-size:30px;letter-spacing:-.02em;margin:0 0 12px}a{color:#7EE2B8}p{color:#C9DBD4}button{font:inherit;font-weight:600;padding:12px 22px;border-radius:999px;border:0;background:#7EE2B8;color:#0D1714;cursor:pointer}</style></head>
<body><main>${body}</main></body></html>`;
}

export interface CreateAppOptions {
  owner: string;
  isOrg: boolean;
  stack: string;
  webhookUrl: string;
  /** Called with the start URL once the local server listens (to print it / open a browser). */
  onReady: (startUrl: string) => void;
  /** Stores the credentials (SSM); runs before the browser is sent on to install the App. */
  save: (app: StoredApp) => Promise<void>;
  convert?: typeof convertManifestCode;
  timeoutMs?: number;
}

/** Resolves with the new App once GitHub has created it and `save` has stored it. */
export function createApp(opts: CreateAppOptions): Promise<StoredApp> {
  const state = randomBytes(24).toString('base64url');
  const convert = opts.convert ?? convertManifestCode;
  let server: Server;
  let base = '';

  return new Promise<StoredApp>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('the GitHub App was not created within 30 minutes')),
      opts.timeoutMs ?? 30 * 60_000,
    );
    const finish = (err: Error | undefined, app?: StoredApp) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (err) reject(err);
      else resolve(app as StoredApp);
    };

    // A plain (non-async) listener, so an unexpected error ends the flow instead of becoming an
    // unhandled rejection.
    server = createServer((req, res) => {
      handle(req, res).catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
    });
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url ?? '/', base);
      const send = (status: number, html: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          ...headers,
        });
        res.end(html);
      };
      const given = url.searchParams.get('state') ?? '';
      if (req.method !== 'GET' || !safeEqual(given, state)) {
        send(404, page('Not found', '<h1>Not found</h1>'));
        return;
      }
      if (url.pathname === '/start') {
        const m = manifest({
          owner: opts.owner,
          isOrg: opts.isOrg,
          stack: opts.stack,
          webhookUrl: opts.webhookUrl,
          redirectUrl: `${base}/callback`,
        });
        send(
          200,
          page(
            'Create runway’s GitHub App',
            `<h1>Create runway’s GitHub App</h1><p>This sends the App’s settings to GitHub, where you confirm them. Its private key comes back to the runway CLI on this machine and is stored in your AWS account, never shown here.</p>
<form method="post" action="${esc(createAppUrl(opts.owner, opts.isOrg, state))}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(m))}"><button>Create GitHub App on ${esc(opts.owner)}</button></form>`,
          ),
        );
        return;
      }
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (!code) {
          send(400, page('Missing code', '<h1>GitHub sent no code</h1><p>Run setup again.</p>'));
          return;
        }
        try {
          const app = await convert(code, opts.owner, opts.isOrg);
          await opts.save(app);
          send(302, '', { location: installUrl(app.slug) });
          finish(undefined, app);
        } catch (e) {
          send(500, page('Setup failed', '<h1>Setup failed</h1><p>See your terminal.</p>'));
          finish(e as Error);
        }
        return;
      }
      send(404, page('Not found', '<h1>Not found</h1>'));
    };
    server.on('error', (e) => finish(e));
    // Loopback only: nothing else on the network can reach it.
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      opts.onReady(`${base}/start?state=${state}`);
    });
  });
}
