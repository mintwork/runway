// Minimal GitHub App client: no dependencies, just what runway needs.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

const API = 'https://api.github.com';

export interface AppCredentials {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
  /** Organization-owned repos get org-level runners; personal repos get repo-level runners. */
  ownerIsOrg: boolean;
}

export interface JitRunner {
  runnerId: number;
  encodedJitConfig: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Verify a webhook delivery's X-Hub-Signature-256 header in constant time. */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A GitHub App JWT (valid 9 minutes, backdated 60 s for clock drift). */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 600, iss: appId })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

type Fetch = typeof fetch;

export class GitHubApp {
  private tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly creds: AppCredentials,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mintwork-runway',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(
        res.status,
        `GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`,
      );
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** An installation access token, cached until 5 minutes before it expires. */
  async installationToken(installationId: number, now = Date.now()): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - 5 * 60_000 > now) return cached.token;
    const jwt = appJwt(this.creds.appId, this.creds.privateKey, now);
    const res = await this.request<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      jwt,
    );
    this.tokens.set(installationId, { token: res.token, expiresAt: Date.parse(res.expires_at) });
    return res.token;
  }

  private runnersPath(ref: RepoRef): string {
    return ref.ownerIsOrg
      ? `/orgs/${ref.owner}/actions/runners`
      : `/repos/${ref.owner}/${ref.repo}/actions/runners`;
  }

  /** Register a single-use (just-in-time) runner and return its config blob. */
  async createJitRunner(
    installationId: number,
    ref: RepoRef,
    name: string,
    labels: string[],
  ): Promise<JitRunner> {
    const token = await this.installationToken(installationId);
    const res = await this.request<{ runner: { id: number }; encoded_jit_config: string }>(
      'POST',
      `${this.runnersPath(ref)}/generate-jitconfig`,
      token,
      { name, runner_group_id: 1, labels, work_folder: '_work' },
    );
    return { runnerId: res.runner.id, encodedJitConfig: res.encoded_jit_config };
  }

  /** Remove a runner registration. A runner that already finished (404) is fine. */
  async deleteRunner(installationId: number, ref: RepoRef, runnerId: number): Promise<void> {
    const token = await this.installationToken(installationId);
    try {
      await this.request('DELETE', `${this.runnersPath(ref)}/${runnerId}`, token);
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) throw e;
    }
  }

  async jobStatus(installationId: number, ref: RepoRef, jobId: number): Promise<string> {
    const token = await this.installationToken(installationId);
    const job = await this.request<{ status: string }>(
      'GET',
      `/repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}`,
      token,
    );
    return job.status;
  }

  /**
   * Explain a refused job on its commit, as a failed "runway" check. Needs the App's Checks
   * permission; Apps created before runway asked for it fail with 403, which callers ignore.
   */
  async reportRefusal(
    installationId: number,
    ref: RepoRef,
    headSha: string,
    jobName: string,
    reason: string,
  ): Promise<void> {
    const token = await this.installationToken(installationId);
    await this.request('POST', `/repos/${ref.owner}/${ref.repo}/check-runs`, token, {
      name: `runway: ${jobName}`.slice(0, 100),
      head_sha: headSha,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: 'runway refused this job',
        summary: `${reason}\n\nThe job waits in GitHub until you cancel it or fix its \`runs-on\`. Labels: https://github.com/mintwork/runway#choosing-the-machine`,
      },
    });
  }

  /** True when the workflow run came from a fork (a pull request from someone else's copy). */
  async runIsFromFork(installationId: number, ref: RepoRef, runId: number): Promise<boolean> {
    const token = await this.installationToken(installationId);
    const run = await this.request<{ head_repository?: { full_name?: string } | null }>(
      'GET',
      `/repos/${ref.owner}/${ref.repo}/actions/runs/${runId}`,
      token,
    );
    const head = run.head_repository?.full_name;
    return !head || head.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase();
  }
}
