import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manifest } from '../src/core/app-manifest.js';
import { handler, safeEqual, signState, verifyState } from '../src/lambda/setup.js';

const ssm = mockClient(SSMClient);
const TOKEN = 'one-time-token';

function event(resource: string, query: Record<string, string> = {}) {
  return {
    resource,
    queryStringParameters: query,
    requestContext: { domainName: 'abc.execute-api.eu-central-1.amazonaws.com', stage: 'github' },
  } as never;
}

function params(values: Record<string, string>) {
  ssm.on(GetParameterCommand).callsFake(async (input: { Name: string }) => {
    const v = values[input.Name];
    if (v === undefined) throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    return { Parameter: { Value: v } };
  });
}

beforeEach(() => {
  ssm.reset();
  process.env.RUNWAY_STACK = 'runway';
  process.env.RUNWAY_GITHUB_OWNER = 'acme';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/users/acme'))
        return new Response(JSON.stringify({ type: 'Organization' }));
      if (String(url).includes('/app-manifests/')) {
        return new Response(
          JSON.stringify({
            id: 9,
            slug: 'runway-acme',
            pem: 'PEM',
            webhook_secret: 'WS',
            html_url: 'https://github.com/apps/runway-acme',
          }),
        );
      }
      return new Response('[]');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('state', () => {
  it('is signed with the setup token, so callbacks can only come from this page', () => {
    const state = signState(TOKEN);
    expect(verifyState(TOKEN, state)).toBe(true);
    expect(verifyState('other-token', state)).toBe(false);
    expect(verifyState(TOKEN, `${state}x`)).toBe(false);
    expect(verifyState(TOKEN, undefined)).toBe(false);
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });
});

describe('manifest', () => {
  it('asks for the narrowest permissions: runners, checks, read-only actions', () => {
    const m = manifest({
      owner: 'acme',
      isOrg: true,
      stack: 'runway',
      webhookUrl: 'https://h/github/',
      redirectUrl: 'https://h/github/setup/callback',
      setupUrl: 'https://h/github/setup',
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
    });
    expect(
      manifest({ owner: 'ada', isOrg: false, stack: 'dev', webhookUrl: '', redirectUrl: '' })
        .default_permissions,
    ).toHaveProperty('administration', 'write');
  });
});

describe('/setup', () => {
  it('refuses without the right one-time token', async () => {
    params({ '/runway/runway/setup-token': TOKEN });
    expect((await handler(event('/setup', { token: 'wrong' }))).statusCode).toBe(403);
    expect((await handler(event('/setup'))).statusCode).toBe(403);
  });

  it('shows a create-App form that posts the manifest to GitHub', async () => {
    params({ '/runway/runway/setup-token': TOKEN });
    const res = await handler(event('/setup', { token: TOKEN }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      'action="https://github.com/organizations/acme/settings/apps/new?state=',
    );
    expect(res.body).toContain(
      'https://abc.execute-api.eu-central-1.amazonaws.com/github/setup/callback',
    );
    expect(res.headers?.['content-security-policy']).toContain('form-action https://github.com');
    expect(res.headers?.['cache-control']).toBe('no-store');
  });

  it('shows progress, without naming the org or App, once the App exists', async () => {
    params({
      '/runway/runway/github-app': JSON.stringify({
        appId: '9',
        privateKey: 'x',
        slug: 'runway-acme',
        owner: 'acme',
        htmlUrl: 'https://github.com/apps/runway-acme',
      }),
    });
    const res = await handler(event('/setup', { token: TOKEN }));
    expect(res.body).toContain('GitHub App created');
    expect(res.body).not.toContain('<form');
    // Not installed yet in this test, so the install link (the one thing a visitor needs) is shown.
    expect(res.body).toContain('installations/new');
    expect(res.body).not.toContain('acme</');
  });
});

describe('/setup/callback', () => {
  it('stores the App, burns the token, and sends you to install it', async () => {
    params({ '/runway/runway/setup-token': TOKEN });
    ssm.on(PutParameterCommand).resolves({});
    ssm.on(DeleteParameterCommand).resolves({});
    const res = await handler(event('/setup/callback', { code: 'C0DE', state: signState(TOKEN) }));
    expect(res).toMatchObject({
      statusCode: 302,
      headers: { location: 'https://github.com/apps/runway-acme/installations/new' },
    });
    const put = ssm.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(put).toMatchObject({
      Name: '/runway/runway/github-app',
      Type: 'SecureString',
      Overwrite: false,
    });
    expect(JSON.parse(put.Value as string)).toMatchObject({
      appId: '9',
      privateKey: 'PEM',
      webhookSecret: 'WS',
      owner: 'acme',
      isOrg: true,
    });
    expect(ssm.commandCalls(DeleteParameterCommand)[0].args[0].input.Name).toBe(
      '/runway/runway/setup-token',
    );
  });

  it("refuses a callback whose state was not signed with this stack's token", async () => {
    params({ '/runway/runway/setup-token': TOKEN });
    const res = await handler(
      event('/setup/callback', { code: 'C0DE', state: signState('attacker') }),
    );
    expect(res.statusCode).toBe(403);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});
