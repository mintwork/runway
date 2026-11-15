// The webhook API only admits GitHub's webhook source ranges (https://api.github.com/meta,
// "hooks"). GitHub changes them rarely; the CLI sets them on every deploy and the weekly
// maintainer keeps them current without a stack update.
import {
  type APIGatewayClient,
  CreateDeploymentCommand,
  GetRestApiCommand,
  UpdateRestApiCommand,
} from '@aws-sdk/client-api-gateway';

export const WEBHOOK_STAGE = 'github';

type Fetch = typeof fetch;

export async function githubHookCidrs(fetchImpl: Fetch = fetch): Promise<string[]> {
  const res = await fetchImpl('https://api.github.com/meta', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'mintwork-runway' },
  });
  if (!res.ok) throw new Error(`could not read GitHub's webhook ranges: ${res.status}`);
  const hooks = ((await res.json()) as { hooks?: string[] }).hooks ?? [];
  if (hooks.length === 0 || !hooks.every((c) => /^[0-9a-f:.]+\/\d+$/i.test(c))) {
    throw new Error("GitHub's meta API returned no usable webhook ranges");
  }
  return hooks;
}

/**
 * The resource policy: the webhook (POST /) only admits GitHub's webhook ranges; the setup pages
 * (GET /setup) are for your browser and protect themselves with a one-time token.
 */
export function ingressPolicy(cidrs: string[]): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Principal: '*', Action: 'execute-api:Invoke', Resource: 'execute-api:/*' },
      {
        Effect: 'Deny',
        Principal: '*',
        Action: 'execute-api:Invoke',
        Resource: 'execute-api:/*/POST/',
        Condition: { NotIpAddress: { 'aws:SourceIp': cidrs } },
      },
    ],
  });
}

/** The source ranges in an API's current policy (API Gateway returns it JSON-escaped). */
export function cidrsInPolicy(policy: string | undefined): string[] {
  if (!policy) return [];
  try {
    const doc = JSON.parse(policy.replace(/\\"/g, '"').replace(/\\\//g, '/')) as {
      Statement?: { Condition?: { NotIpAddress?: { 'aws:SourceIp'?: string | string[] } } }[];
    };
    const ips = doc.Statement?.find((s) => s.Condition?.NotIpAddress)?.Condition?.NotIpAddress?.[
      'aws:SourceIp'
    ];
    return Array.isArray(ips) ? ips : ips ? [ips] : [];
  } catch {
    return [];
  }
}

export const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Make the live API admit exactly `cidrs`. A REST API's policy only takes effect after a new
 * deployment, so this redeploys the stage when the policy changed (or when `force` is set,
 * e.g. right after a stack update that may have changed it).
 */
export async function syncIngress(
  client: APIGatewayClient,
  restApiId: string,
  cidrs: string[],
  force = false,
): Promise<boolean> {
  const api = await client.send(new GetRestApiCommand({ restApiId }));
  const changed = !sameSet(cidrsInPolicy(api.policy), cidrs);
  if (changed) {
    await client.send(
      new UpdateRestApiCommand({
        restApiId,
        patchOperations: [{ op: 'replace', path: '/policy', value: ingressPolicy(cidrs) }],
      }),
    );
  }
  if (changed || force) {
    await client.send(
      new CreateDeploymentCommand({
        restApiId,
        stageName: WEBHOOK_STAGE,
        description: `runway: GitHub webhook ranges ${cidrs.length}`,
      }),
    );
  }
  return changed;
}
