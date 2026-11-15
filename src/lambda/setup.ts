// The "Finish setup" page, served from your own stack (GET /setup and /setup/callback).
//
//   /setup?token=…      checks the one-time setup token, then shows a button that sends a
//                       prefilled App manifest to GitHub (state = nonce signed with the token).
//   /setup/callback     GitHub redirects here with a one-time code. This function redeems it
//                       server-side, stores the App's credentials in SSM, burns the setup token
//                       and sends you on to install the App.
//   /setup (afterwards) a progress page: App created, installed, images built. No secrets.
//
// The App's private key goes from GitHub to this function to SSM; it never reaches a browser.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  convertManifestCode,
  createAppUrl,
  installUrl,
  manifest,
  ownerIsOrg,
  type StoredApp,
} from '../core/app-manifest.js';
import type { ImageRegistry } from '../core/config.js';
import { appJwt } from '../core/github.js';
import { microvmImageState } from '../core/images.js';

const ssm = new SSMClient({});
const microvms = new LambdaMicrovmsClient({});

const env = () => {
  const stack = process.env.RUNWAY_STACK as string;
  return {
    stack,
    owner: process.env.RUNWAY_GITHUB_OWNER as string,
    appParam: `/runway/${stack}/github-app`,
    tokenParam: `/runway/${stack}/setup-token`,
    imagesParam: `/runway/${stack}/images`,
  };
};

async function getParam(name: string, decrypt = true): Promise<string | undefined> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt })))
      .Parameter?.Value;
  } catch (e) {
    if ((e as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw e;
  }
}

/** state = nonce.signature, so the callback can prove the request started on this page. */
export function signState(token: string, nonce = randomBytes(16).toString('hex')): string {
  return `${nonce}.${createHmac('sha256', token).update(nonce).digest('hex')}`;
}

export function verifyState(token: string, state: string | undefined): boolean {
  const [nonce, sig] = (state ?? '').split('.');
  if (!nonce || !sig) return false;
  const expected = Buffer.from(createHmac('sha256', token).update(nonce).digest('hex'));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function page(title: string, body: string): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · runway</title>
<style>body{margin:0;background:#0D1714;color:#E6F2ED;font:17px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:600px;padding:32px}h1{font-size:30px;letter-spacing:-.02em;margin:0 0 12px}a{color:#7EE2B8}p,li{color:#C9DBD4}button{font:inherit;font-weight:600;padding:12px 22px;border-radius:999px;border:0;background:#7EE2B8;color:#0D1714;cursor:pointer}code{background:#13211d;border:1px solid #22362f;border-radius:5px;padding:1px 6px}ul{padding-left:20px}.ok{color:#7EE2B8}.wait{color:#E5C07B}</style></head>
<body><main><p><strong>runway</strong></p>${body}</main></body></html>`,
  };
}

const redirect = (location: string): APIGatewayProxyResult => ({
  statusCode: 302,
  headers: { location, 'cache-control': 'no-store' },
  body: '',
});
const notFound = (msg: string) => ({
  ...page('Not available', `<h1>Not available</h1><p>${esc(msg)}</p>`),
  statusCode: 403,
});

function baseUrl(event: APIGatewayProxyEvent): string {
  return `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
}

async function progress(app: StoredApp): Promise<APIGatewayProxyResult> {
  const { imagesParam } = env();
  let installed: string | undefined;
  try {
    const res = await fetch('https://api.github.com/app/installations', {
      headers: {
        authorization: `Bearer ${appJwt(app.appId, app.privateKey)}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'mintwork-runway',
      },
    });
    const list = (await res.json()) as {
      account: { login: string };
      repository_selection: string;
    }[];
    const mine = list.find((i) => i.account.login.toLowerCase() === app.owner.toLowerCase());
    if (mine)
      installed =
        mine.repository_selection === 'all' ? 'all repositories' : 'selected repositories';
  } catch {
    // shown as "not yet"
  }
  const raw = await getParam(imagesParam, false);
  const registry = raw ? (JSON.parse(raw) as ImageRegistry) : undefined;
  const images: string[] = [];
  for (const [key, arn] of Object.entries(registry?.microvm ?? {})) {
    const s = await microvmImageState(microvms, arn).catch(() => undefined);
    images.push(
      s?.active
        ? `<span class="ok">✓</span> MicroVM image ${esc(key)}`
        : `<span class="wait">…</span> MicroVM image ${esc(key)} is building`,
    );
  }
  const step = (done: boolean, text: string) =>
    `<li>${done ? '<span class="ok">✓</span>' : '<span class="wait">…</span>'} ${text}</li>`;
  return page(
    'runway setup',
    `<h1>${installed && images.every((i) => i.includes('✓')) && images.length ? 'runway is ready' : 'Setting up runway'}</h1><ul>
${step(true, `GitHub App <a href="${esc(app.htmlUrl)}">${esc(app.slug)}</a> created`)}
${step(Boolean(installed), installed ? `Installed on ${esc(app.owner)} (${installed})` : `Not installed yet: <a href="${esc(installUrl(app.slug))}">install it on your repositories</a>`)}
${images.length ? images.map((i) => `<li>${i}</li>`).join('') : step(false, 'Runner images are building (about 10 minutes)')}
</ul><p>Then use <code>runs-on: [runway]</code> in a workflow. Fargate and Lambda images build alongside; <code>npx @mintwork/runway status</code> shows everything.</p>`,
  );
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { stack, owner, appParam, tokenParam } = env();
  const q = event.queryStringParameters ?? {};
  const appJson = await getParam(appParam);

  if (event.resource === '/setup') {
    if (appJson) return progress(JSON.parse(appJson) as StoredApp);
    const token = await getParam(tokenParam);
    if (!token || !q.token || !safeEqual(token, q.token))
      return notFound(
        'This setup link is invalid. Use the SetupUrl from your runway stack outputs.',
      );
    const isOrg = await ownerIsOrg(owner);
    const base = baseUrl(event);
    const m = manifest({
      owner,
      isOrg,
      stack,
      webhookUrl: `${base}/`,
      redirectUrl: `${base}/setup/callback`,
      setupUrl: `${base}/setup`,
    });
    return page(
      'Create the GitHub App',
      `<h1>Create runway's GitHub App</h1>
<p>runway needs a GitHub App on <strong>${esc(owner)}</strong> to receive job events and register single-use runners. GitHub shows its permissions before you confirm:</p>
<ul><li>${isOrg ? 'Self-hosted runners: read &amp; write' : 'Administration: read &amp; write (GitHub requires it for repository runners)'}</li><li>Checks: read &amp; write (explains refused jobs on your commits)</li><li>Actions, Metadata: read</li></ul>
<p>The App's private key is created by GitHub and stored only in your AWS account.</p>
<form method="post" action="${esc(createAppUrl(owner, isOrg, signState(token)))}"><input type="hidden" name="manifest" value="${esc(JSON.stringify(m))}"><button>Create GitHub App on ${esc(owner)}</button></form>`,
    );
  }

  if (event.resource === '/setup/callback') {
    if (appJson) return redirect(`${baseUrl(event)}/setup`);
    const token = await getParam(tokenParam);
    if (!token || !q.code || !verifyState(token, q.state))
      return notFound('This callback is not part of a setup started from your stack.');
    const app = await convertManifestCode(q.code, owner, await ownerIsOrg(owner));
    await ssm.send(
      new PutParameterCommand({
        Name: appParam,
        Type: 'SecureString',
        Value: JSON.stringify(app),
        Overwrite: false,
      }),
    );
    await ssm.send(new DeleteParameterCommand({ Name: tokenParam }));
    return redirect(installUrl(app.slug));
  }

  return notFound('Unknown page.');
}
