// GitHub App helpers for the CLI. The App itself is created on the stack's setup page.
import { spawn } from 'node:child_process';
import type { AppCredentials } from '../core/github.js';
import { appJwt } from '../core/github.js';
import { CliError } from './ui.js';

const API = 'https://api.github.com';
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'mintwork-runway',
  'x-github-api-version': '2022-11-28',
};

export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // The URL is printed too.
  }
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
  timeoutMs = 15 * 60_000,
): Promise<Installation> {
  const start = Date.now();
  for (;;) {
    const found = (await installations(creds)).find(
      (i) => i.account.login.toLowerCase() === owner.toLowerCase(),
    );
    if (found) return found;
    if (Date.now() - start > timeoutMs) {
      throw new CliError(
        `The App isn't installed on ${owner} yet. Install it and run "runway status".`,
      );
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}
