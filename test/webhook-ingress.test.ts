import {
  APIGatewayClient,
  CreateDeploymentCommand,
  GetRestApiCommand,
  UpdateRestApiCommand,
} from '@aws-sdk/client-api-gateway';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cidrsInPolicy,
  githubHookCidrs,
  ingressPolicy,
  syncIngress,
} from '../src/core/webhook-ingress.js';
import { normalize } from '../src/lambda/webhook.js';

const ranges = ['192.30.252.0/22', '2606:50c0::/32'];

describe('githubHookCidrs', () => {
  it("reads GitHub's webhook ranges", async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ hooks: ranges, web: ['1.2.3.4/32'] }));
    expect(await githubHookCidrs(fetchMock)).toEqual(ranges);
  });

  it('refuses an empty or malformed list rather than opening (or closing) the API', async () => {
    await expect(
      githubHookCidrs(async () => new Response(JSON.stringify({ hooks: [] }))),
    ).rejects.toThrow('no usable');
    await expect(
      githubHookCidrs(async () => new Response(JSON.stringify({ hooks: ['*'] }))),
    ).rejects.toThrow('no usable');
    await expect(githubHookCidrs(async () => new Response('', { status: 503 }))).rejects.toThrow(
      '503',
    );
  });
});

describe('ingress policy', () => {
  it('denies every source outside the ranges', () => {
    const policy = JSON.parse(ingressPolicy(ranges));
    expect(policy.Statement[1]).toMatchObject({
      Effect: 'Deny',
      Condition: { NotIpAddress: { 'aws:SourceIp': ranges } },
    });
  });

  it('reads the ranges back from the JSON-escaped policy API Gateway returns', () => {
    const escaped = ingressPolicy(ranges).replace(/"/g, '\\"').replace(/\//g, '\\/');
    expect(cidrsInPolicy(escaped)).toEqual(ranges);
    expect(cidrsInPolicy(undefined)).toEqual([]);
  });
});

describe('syncIngress', () => {
  const apigw = mockClient(APIGatewayClient);
  beforeEach(() => apigw.reset());

  it('updates the policy and redeploys only when the ranges changed', async () => {
    apigw.on(GetRestApiCommand).resolves({ policy: ingressPolicy(['192.30.252.0/22']) });
    expect(await syncIngress(new APIGatewayClient({}), 'api1', ranges)).toBe(true);
    expect(apigw.commandCalls(UpdateRestApiCommand)).toHaveLength(1);
    expect(apigw.commandCalls(CreateDeploymentCommand)[0].args[0].input).toMatchObject({
      restApiId: 'api1',
      stageName: 'github',
    });

    apigw.reset();
    apigw.on(GetRestApiCommand).resolves({ policy: ingressPolicy([...ranges].reverse()) });
    expect(await syncIngress(new APIGatewayClient({}), 'api1', ranges)).toBe(false);
    expect(apigw.commandCalls(UpdateRestApiCommand)).toHaveLength(0);
    expect(apigw.commandCalls(CreateDeploymentCommand)).toHaveLength(0);
  });

  it('redeploys anyway when forced (after a stack update changed the policy)', async () => {
    apigw.on(GetRestApiCommand).resolves({ policy: ingressPolicy(ranges) });
    await syncIngress(new APIGatewayClient({}), 'api1', ranges, true);
    expect(apigw.commandCalls(CreateDeploymentCommand)).toHaveLength(1);
  });
});

describe('webhook normalize', () => {
  it('reads REST API events with mixed-case headers', () => {
    const n = normalize({
      httpMethod: 'POST',
      headers: { 'X-Hub-Signature-256': 'sha256=x', 'X-GitHub-Event': 'ping' },
      body: '{}',
      isBase64Encoded: false,
    } as never);
    expect(n).toEqual({
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=x', 'x-github-event': 'ping' },
      body: '{}',
    });
  });

  it('reads HTTP API / Function URL events and base64 bodies', () => {
    const n = normalize({
      requestContext: { http: { method: 'POST' } },
      headers: {},
      body: Buffer.from('{"a":1}').toString('base64'),
      isBase64Encoded: true,
    } as never);
    expect(n).toMatchObject({ method: 'POST', body: '{"a":1}' });
  });
});
