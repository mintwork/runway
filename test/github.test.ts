import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { appJwt, GitHubApp, GitHubError, verifySignature } from '../src/core/github.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const creds = { appId: '123', privateKey: pem, webhookSecret: 's3cret' };

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

describe('verifySignature', () => {
  const body = '{"action":"queued"}';
  const good = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;

  it('accepts the signature GitHub computes', () => {
    expect(verifySignature('s3cret', body, good)).toBe(true);
  });

  it('rejects a wrong secret, a changed body, or a missing header', () => {
    expect(verifySignature('other', body, good)).toBe(false);
    expect(verifySignature('s3cret', `${body} `, good)).toBe(false);
    expect(verifySignature('s3cret', body, undefined)).toBe(false);
    expect(verifySignature('s3cret', body, 'sha1=abc')).toBe(false);
  });
});

describe('appJwt', () => {
  it('signs a 10-minute token backdated 60 s, verifiable with the public key', () => {
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    const [h, p, sig] = appJwt('123', pem, now).split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '123' });
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig, 'base64url')).toBe(
      true,
    );
  });
});

describe('GitHubApp', () => {
  it('caches installation tokens until 5 minutes before they expire', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(201, { token: 'tok', expires_at: '2026-11-15T13:00:00Z' }),
    );
    const app = new GitHubApp(creds, fetchMock);
    expect(await app.installationToken(7, Date.parse('2026-11-15T12:00:00Z'))).toBe('tok');
    expect(await app.installationToken(7, Date.parse('2026-11-15T12:54:00Z'))).toBe('tok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.installationToken(7, Date.parse('2026-11-15T12:56:00Z'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/app/installations/7/access_tokens',
    );
  });

  it('registers org runners at the org and personal runners on the repo', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/access_tokens'))
        return json(201, { token: 'tok', expires_at: '2099-01-01T00:00:00Z' });
      calls.push({ url: u, body: JSON.parse(String(init?.body)) });
      return json(201, { runner: { id: 42 }, encoded_jit_config: 'BLOB' });
    });
    const app = new GitHubApp(creds, fetchMock);
    const org = await app.createJitRunner(
      1,
      { owner: 'acme', repo: 'api', ownerIsOrg: true },
      'runway-a',
      ['runway'],
    );
    await app.createJitRunner(1, { owner: 'ada', repo: 'site', ownerIsOrg: false }, 'runway-b', [
      'runway',
      'ec2',
    ]);
    expect(org).toEqual({ runnerId: 42, encodedJitConfig: 'BLOB' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/orgs/acme/actions/runners/generate-jitconfig',
      'https://api.github.com/repos/ada/site/actions/runners/generate-jitconfig',
    ]);
    expect(calls[1].body).toEqual({
      name: 'runway-b',
      runner_group_id: 1,
      labels: ['runway', 'ec2'],
      work_folder: '_work',
    });
  });

  it('treats deleting an already-removed runner as done, but surfaces other errors', async () => {
    let status = 404;
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/access_tokens')
        ? json(201, { token: 'tok', expires_at: '2099-01-01T00:00:00Z' })
        : json(status, { message: 'x' }),
    );
    const app = new GitHubApp(creds, fetchMock);
    const ref = { owner: 'ada', repo: 'site', ownerIsOrg: false };
    await expect(app.deleteRunner(1, ref, 42)).resolves.toBeUndefined();
    status = 500;
    await expect(app.deleteRunner(1, ref, 42)).rejects.toBeInstanceOf(GitHubError);
  });

  it('detects runs from forks by comparing the head repository', async () => {
    let head: unknown = { full_name: 'Ada/Site' };
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/access_tokens')
        ? json(201, { token: 'tok', expires_at: '2099-01-01T00:00:00Z' })
        : json(200, { head_repository: head }),
    );
    const app = new GitHubApp(creds, fetchMock);
    const ref = { owner: 'ada', repo: 'site', ownerIsOrg: false };
    expect(await app.runIsFromFork(1, ref, 9)).toBe(false);
    head = { full_name: 'mallory/site' };
    expect(await app.runIsFromFork(1, ref, 9)).toBe(true);
    head = null;
    expect(await app.runIsFromFork(1, ref, 9)).toBe(true);
  });
});
