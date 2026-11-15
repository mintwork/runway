// The GitHub App runway creates for you (GitHub's manifest flow), and the exchange of the
// one-time code GitHub returns for the App's credentials.
// https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

const API = 'https://api.github.com';
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'mintwork-runway',
  'x-github-api-version': '2022-11-28',
};

type Fetch = typeof fetch;

export interface StoredApp {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  slug: string;
  owner: string;
  isOrg: boolean;
  htmlUrl: string;
}

export async function ownerIsOrg(owner: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  const res = await fetchImpl(`${API}/users/${encodeURIComponent(owner)}`, { headers });
  if (res.status === 404) throw new Error(`GitHub has no user or organization called "${owner}"`);
  if (!res.ok) throw new Error(`couldn't look up ${owner} on GitHub (${res.status})`);
  return ((await res.json()) as { type: string }).type === 'Organization';
}

export function appName(owner: string, stack: string): string {
  return (stack === 'runway' ? `runway-${owner}` : `runway-${owner}-${stack}`).slice(0, 34);
}

/**
 * Least privilege: org runners need only "Self-hosted runners"; repository runners (personal
 * accounts) need "Administration". "Checks" lets runway explain refused jobs on the commit.
 */
export function manifest(opts: {
  owner: string;
  isOrg: boolean;
  stack: string;
  webhookUrl: string;
  redirectUrl: string;
}) {
  return {
    name: appName(opts.owner, opts.stack),
    url: 'https://mintwork.github.io/runway/',
    description: 'Runs GitHub Actions jobs on your own AWS compute (runway by mintwork).',
    hook_attributes: { url: opts.webhookUrl, active: true },
    redirect_url: opts.redirectUrl,
    public: false,
    default_permissions: {
      ...(opts.isOrg ? { organization_self_hosted_runners: 'write' } : { administration: 'write' }),
      actions: 'read',
      checks: 'write',
      metadata: 'read',
    },
    default_events: ['workflow_job'],
  };
}

/** Where the browser posts the manifest. */
export function createAppUrl(owner: string, isOrg: boolean, state: string): string {
  return isOrg
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${encodeURIComponent(state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
}

/** Redeem the one-time code (valid for an hour, single use) for the App's credentials. */
export async function convertManifestCode(
  code: string,
  owner: string,
  isOrg: boolean,
  fetchImpl: Fetch = fetch,
): Promise<StoredApp> {
  const res = await fetchImpl(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers,
  });
  if (!res.ok)
    throw new Error(
      `GitHub couldn't create the App (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  const app = (await res.json()) as {
    id: number;
    slug: string;
    pem: string;
    webhook_secret: string;
    html_url: string;
  };
  return {
    appId: String(app.id),
    privateKey: app.pem,
    webhookSecret: app.webhook_secret,
    slug: app.slug,
    owner,
    isOrg,
    htmlUrl: app.html_url,
  };
}

export const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;
