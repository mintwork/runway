import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/cli/create-app.js';
import { manifest, type StoredApp } from '../src/core/app-manifest.js';

describe('manifest', () => {
  it('asks for the narrowest permissions: runners, checks, read-only actions', () => {
    const m = manifest({
      owner: 'acme',
      isOrg: true,
      stack: 'runway',
      webhookUrl: 'https://h/github/',
      redirectUrl: 'http://127.0.0.1:5000/callback',
    });
    expect(m.default_permissions).toEqual({
      organization_self_hosted_runners: 'write',
      actions: 'read',
      checks: 'write',
      metadata: 'read',
    });
    expect(m).toMatchObject({
      name: 'runway-acme',
      public: false,
      default_events: ['workflow_job'],
      hook_attributes: { url: 'https://h/github/' },
      redirect_url: 'http://127.0.0.1:5000/callback',
    });
    expect(m).not.toHaveProperty('setup_url');
    expect(
      manifest({ owner: 'ada', isOrg: false, stack: 'dev', webhookUrl: '', redirectUrl: '' })
        .default_permissions,
    ).toHaveProperty('administration', 'write');
  });
});

const APP: StoredApp = {
  appId: '9',
  privateKey: 'PEM',
  webhookSecret: 'WS',
  slug: 'runway-acme',
  owner: 'acme',
  isOrg: true,
  htmlUrl: 'https://github.com/apps/runway-acme',
};

/** Starts the flow and hands back the start URL the CLI would print. */
function start(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const save = vi.fn(async () => {});
  const convert = vi.fn(async () => APP);
  let ready: (url: string) => void = () => {};
  const url = new Promise<string>((r) => {
    ready = r;
  });
  const done = createApp({
    owner: 'acme',
    isOrg: true,
    stack: 'runway',
    webhookUrl: 'https://h/github/',
    onReady: (u) => ready(u),
    save,
    convert,
    ...overrides,
  });
  // It may fail while a test is still awaiting a request; the test checks it afterwards.
  done.catch(() => {});
  return { url, done, save, convert };
}

describe('createApp (local manifest flow)', () => {
  it('listens on loopback only and posts the manifest to GitHub', async () => {
    const { url, done } = start({ timeoutMs: 2000 });
    const startUrl = new URL(await url);
    expect(startUrl.hostname).toBe('127.0.0.1');
    const html = await (await fetch(startUrl)).text();
    expect(html).toContain(
      'action="https://github.com/organizations/acme/settings/apps/new?state=',
    );
    expect(html).toContain(`${startUrl.origin}/callback`);
    await expect(done).rejects.toThrow(/not created/);
  });

  it('refuses requests without the state it issued', async () => {
    const { url, done, convert } = start({ timeoutMs: 2000 });
    const origin = new URL(await url).origin;
    expect((await fetch(`${origin}/start`)).status).toBe(404);
    expect((await fetch(`${origin}/start?state=guess`)).status).toBe(404);
    expect((await fetch(`${origin}/callback?code=C&state=guess`)).status).toBe(404);
    expect(convert).not.toHaveBeenCalled();
    await expect(done).rejects.toThrow();
  });

  it('redeems the code, saves the App, then sends the browser to install it', async () => {
    const { url, done, save, convert } = start();
    const startUrl = new URL(await url);
    const state = startUrl.searchParams.get('state');
    const res = await fetch(`${startUrl.origin}/callback?code=C0DE&state=${state}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://github.com/apps/runway-acme/installations/new',
    );
    expect(convert).toHaveBeenCalledWith('C0DE', 'acme', true);
    expect(save).toHaveBeenCalledWith(APP);
    await expect(done).resolves.toEqual(APP);
  });

  it('fails (and saves nothing) when GitHub refuses the code', async () => {
    const { url, done, save } = start({
      convert: vi.fn(async () => {
        throw new Error('GitHub couldn’t create the App (404)');
      }),
    });
    const startUrl = new URL(await url);
    const state = startUrl.searchParams.get('state');
    const res = await fetch(`${startUrl.origin}/callback?code=bad&state=${state}`);
    expect(res.status).toBe(500);
    expect(save).not.toHaveBeenCalled();
    await expect(done).rejects.toThrow(/404/);
  });
});
