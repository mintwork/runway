// Creating runway's GitHub App with GitHub's manifest flow: the CLI serves a local page that
// posts a prefilled App definition to GitHub, you click "Create", GitHub redirects back to the
// CLI with a one-time code, and the CLI exchanges it for the App's ID, private key and webhook
// secret. Nothing to copy by hand. https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { type AppCredentials, appJwt } from '../core/github.js';
import { CliError, info, step } from './ui.js';

export interface StoredApp extends AppCredentials {
  slug: string;
  owner: string;
  isOrg: boolean;
  htmlUrl: string;
}

const API = 'https://api.github.com';
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'mintwork-runway',
  'x-github-api-version': '2022-11-28',
};

export async function ownerType(owner: string): Promise<'Organization' | 'User'> {
  const res = await fetch(`${API}/users/${encodeURIComponent(owner)}`, { headers });
  if (res.status === 404)
    throw new CliError(`GitHub has no user or organization called "${owner}"`);
  if (!res.ok) throw new CliError(`Couldn't look up ${owner} on GitHub (${res.status})`);
  return ((await res.json()) as { type: string }).type === 'Organization' ? 'Organization' : 'User';
}

/** Least privilege: org runners need only "Self-hosted runners"; repo runners need "Administration". */
export function manifest(
  owner: string,
  isOrg: boolean,
  webhookUrl: string,
  redirectUrl: string,
  stack: string,
) {
  return {
    name:
      stack === 'runway' ? `runway-${owner}`.slice(0, 34) : `runway-${owner}-${stack}`.slice(0, 34),
    url: 'https://mintwork.github.io/runway/',
    description: 'Runs GitHub Actions jobs on your own AWS compute (runway by mintwork).',
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: isOrg
      ? { organization_self_hosted_runners: 'write', actions: 'read', metadata: 'read' }
      : { administration: 'write', actions: 'read', metadata: 'read' },
    default_events: ['workflow_job'],
  };
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is printed too.
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;background:#0D1714;color:#E6F2ED;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:560px">${body}</main></body></html>`;

/** Run the manifest flow and return the new App's credentials. */
export async function createApp(opts: {
  owner: string;
  isOrg: boolean;
  webhookUrl: string;
  stack: string;
  browser: boolean;
}): Promise<StoredApp> {
  const state = randomBytes(16).toString('hex');
  return new Promise<StoredApp>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new CliError('Timed out waiting for the GitHub App to be created (10 minutes).'));
    }, 10 * 60_000);

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        const port = (server.address() as { port: number }).port;
        const m = manifest(
          opts.owner,
          opts.isOrg,
          opts.webhookUrl,
          `http://127.0.0.1:${port}/callback`,
          opts.stack,
        );
        const action = opts.isOrg
          ? `https://github.com/organizations/${encodeURIComponent(opts.owner)}/settings/apps/new?state=${state}`
          : `https://github.com/settings/apps/new?state=${state}`;
        const json = JSON.stringify(m).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          page(
            'runway: create the GitHub App',
            `<h1>Create runway's GitHub App</h1><p>GitHub will show the App's permissions before you confirm.</p><form method="post" action="${action}"><input type="hidden" name="manifest" value="${json}"><button style="font:inherit;padding:10px 18px;border-radius:999px;border:0;background:#7EE2B8;color:#0D1714;font-weight:600;cursor:pointer">Continue to GitHub</button></form><script>document.forms[0].submit()</script>`,
          ),
        );
        return;
      }
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.get('state') !== state) {
          res.writeHead(400).end('Invalid callback');
          return;
        }
        try {
          const conv = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
            method: 'POST',
            headers,
          });
          if (!conv.ok) throw new Error(`GitHub returned ${conv.status}: ${await conv.text()}`);
          const app = (await conv.json()) as {
            id: number;
            slug: string;
            pem: string;
            webhook_secret: string;
            html_url: string;
          };
          const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
          res.writeHead(302, { location: installUrl }).end();
          clearTimeout(timer);
          server.close();
          resolve({
            appId: String(app.id),
            privateKey: app.pem,
            webhookSecret: app.webhook_secret,
            slug: app.slug,
            owner: opts.owner,
            isOrg: opts.isOrg,
            htmlUrl: app.html_url,
          });
        } catch (e) {
          res
            .writeHead(500, { 'content-type': 'text/html' })
            .end(page('runway: error', `<h1>Something went wrong</h1><p>${String(e)}</p>`));
          clearTimeout(timer);
          server.close();
          reject(e);
        }
        return;
      }
      res.writeHead(404).end();
    });

    server.listen(0, '127.0.0.1', () => {
      const local = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      step(`Create the GitHub App: ${local}`);
      info('Click "Create GitHub App" on GitHub; you then choose which repositories it can see.');
      if (opts.browser) openBrowser(local);
    });
  });
}

async function appRequest<T>(
  creds: AppCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...headers,
      authorization: `Bearer ${appJwt(creds.appId, creds.privateKey)}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new CliError(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Point the App's webhook at the (possibly new) stack URL. */
export async function setWebhookUrl(creds: AppCredentials, url: string): Promise<void> {
  await appRequest(creds, 'PATCH', '/app/hook/config', {
    url,
    content_type: 'json',
    insecure_ssl: '0',
  });
}

export interface Installation {
  id: number;
  account: { login: string };
  repository_selection: 'all' | 'selected';
}

export async function installations(creds: AppCredentials): Promise<Installation[]> {
  return appRequest<Installation[]>(creds, 'GET', '/app/installations');
}

export async function waitForInstallation(
  creds: AppCredentials,
  owner: string,
  timeoutMs = 10 * 60_000,
): Promise<Installation> {
  const start = Date.now();
  for (;;) {
    const found = (await installations(creds)).find(
      (i) => i.account.login.toLowerCase() === owner.toLowerCase(),
    );
    if (found) return found;
    if (Date.now() - start > timeoutMs)
      throw new CliError(
        `The App isn't installed on ${owner} yet. Install it and run "runway status".`,
      );
    await new Promise((r) => setTimeout(r, 4000));
  }
}
