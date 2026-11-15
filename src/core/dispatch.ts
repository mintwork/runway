// What runway does with each workflow_job event, and the periodic sweep. Pure orchestration:
// GitHub, DynamoDB and the compute providers are injected, so every decision is testable.
import { randomBytes } from 'node:crypto';
import { CapacityError, type Provider } from '../providers/types.js';
import type { Config } from './config.js';
import type { GitHubApp, RepoRef } from './github.js';
import { type Compute, describeSpec, hasTrigger, parseLabels, specFor } from './labels.js';
import { type RunnerRecord, type State, ttlFromNow } from './state.js';

export interface QueuedJob {
  jobId: number;
  runId: number;
  labels: string[];
  owner: string;
  repo: string;
  ownerIsOrg: boolean;
  private: boolean;
  installationId: number;
}

export interface Deps {
  config: Config;
  github: Pick<GitHubApp, 'createJitRunner' | 'deleteRunner' | 'runIsFromFork' | 'jobStatus'>;
  state: Pick<
    State,
    'claimJob' | 'releaseJob' | 'putRunner' | 'getRunner' | 'update' | 'activeRunners'
  >;
  providers: Partial<Record<Compute, Provider>>;
  log: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  newRunnerName?: () => string;
}

export type QueuedOutcome =
  | { status: 'ignored'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'duplicate' }
  | { status: 'launched'; runnerName: string; compute: Compute; resourceId: string };

/** Thrown when no compute type had capacity: the queue message is retried later. */
export class RetryLater extends Error {}

export const newRunnerName = () => `runway-${randomBytes(5).toString('hex')}`;

/** The compute types to try, in order, following the configured fallbacks without loops. */
export function fallbackChain(
  first: Compute,
  fallback: Partial<Record<Compute, Compute>>,
): Compute[] {
  const chain: Compute[] = [first];
  let next = fallback[first];
  while (next && !chain.includes(next)) {
    chain.push(next);
    next = fallback[next];
  }
  return chain;
}

export async function handleQueued(job: QueuedJob, deps: Deps): Promise<QueuedOutcome> {
  const { config, github, state, log } = deps;
  const now = deps.now ?? Date.now;
  if (!hasTrigger(job.labels)) return { status: 'ignored', reason: 'no runway label' };

  const ref: RepoRef = { owner: job.owner, repo: job.repo, ownerIsOrg: job.ownerIsOrg };
  const where = `${job.owner}/${job.repo}`;
  const reject = (reason: string): QueuedOutcome => {
    log('rejected job', { job: job.jobId, repo: where, reason });
    return { status: 'rejected', reason };
  };

  if (config.allowedOwners.length && !config.allowedOwners.includes(job.owner.toLowerCase())) {
    return reject(`owner ${job.owner} is not in AllowedOwners`);
  }
  if (!job.private) {
    if (!config.allowPublicRepos)
      return reject('public repository; set AllowPublicRepos=true to allow');
    if (await github.runIsFromFork(job.installationId, ref, job.runId))
      return reject('workflow run from a fork');
  }
  const parsed = parseLabels(job.labels, { compute: config.defaultCompute });
  if (!parsed.ok) return reject(parsed.error);

  const runnerName = (deps.newRunnerName ?? newRunnerName)();
  if (!(await state.claimJob(job.jobId, runnerName, now()))) return { status: 'duplicate' };

  const record: RunnerRecord = {
    pk: runnerName,
    compute: parsed.spec.compute,
    owner: job.owner,
    repo: job.repo,
    ownerIsOrg: job.ownerIsOrg,
    installationId: job.installationId,
    jobId: job.jobId,
    runId: job.runId,
    state: 'launching',
    launchedAt: now(),
    ttl: ttlFromNow(config.maxJobMinutes * 60 + 3 * 24 * 3600, now()),
  };
  await state.putRunner(record);

  let runnerId: number | undefined;
  const cleanUp = async (error: string) => {
    if (runnerId) await github.deleteRunner(job.installationId, ref, runnerId).catch(() => {});
    await state.update(runnerName, { state: 'failed', error });
    await state.releaseJob(job.jobId);
  };

  try {
    const jit = await github.createJitRunner(job.installationId, ref, runnerName, job.labels);
    runnerId = jit.runnerId;
    await state.update(runnerName, { runnerId });

    const capacityErrors: string[] = [];
    for (const compute of fallbackChain(parsed.spec.compute, config.fallback)) {
      const provider = deps.providers[compute];
      const spec = specFor(compute, parsed.spec);
      if (!provider || !spec) continue;
      try {
        const launched = await provider.launch({
          runnerName,
          jitConfig: jit.encodedJitConfig,
          spec,
          maxSeconds: config.maxJobMinutes * 60,
        });
        await state.update(runnerName, {
          state: 'launched',
          compute,
          resourceId: launched.resourceId,
          detail: launched.detail ?? describeSpec(spec),
        });
        log('launched runner', {
          runner: runnerName,
          job: job.jobId,
          repo: where,
          compute,
          resource: launched.resourceId,
          detail: launched.detail,
        });
        return { status: 'launched', runnerName, compute, resourceId: launched.resourceId };
      } catch (e) {
        if (!(e instanceof CapacityError)) throw e;
        capacityErrors.push(e.message);
        log('no capacity, trying the next compute type', { runner: runnerName, error: e.message });
      }
    }
    const error = capacityErrors.join(' | ') || `no provider configured for ${parsed.spec.compute}`;
    await cleanUp(error);
    throw new RetryLater(error);
  } catch (e) {
    if (e instanceof RetryLater) throw e;
    await cleanUp((e as Error).message);
    throw e;
  }
}

/** The runner picked up a job: remember which one, so the sweep never touches a busy runner. */
export async function handleInProgress(
  runnerName: string,
  jobId: number,
  deps: Deps,
): Promise<void> {
  if (!runnerName.startsWith('runway-')) return;
  const record = await deps.state.getRunner(runnerName);
  if (!record) return;
  await deps.state.update(runnerName, { state: 'busy', busyJobId: jobId });
}

/** The job finished (or was cancelled): stop paying for the machine right away. */
export async function handleCompleted(runnerName: string, deps: Deps): Promise<void> {
  if (!runnerName.startsWith('runway-')) return;
  const record = await deps.state.getRunner(runnerName);
  if (!record || record.state === 'done') return;
  await terminate(record, deps, 'job completed');
}

async function terminate(record: RunnerRecord, deps: Deps, reason: string): Promise<void> {
  if (record.resourceId) await deps.providers[record.compute]?.terminate(record.resourceId);
  await deps.state.update(record.pk, {
    state: 'done',
    error: reason === 'job completed' ? undefined : reason,
  });
  deps.log('terminated runner', {
    runner: record.pk,
    compute: record.compute,
    resource: record.resourceId,
    reason,
  });
}

export interface SweepResult {
  terminated: string[];
  orphans: string[];
}

/**
 * Runs every few minutes. Ends runners that outlived the job time limit, runners whose job
 * no longer needs them (cancelled before it started), launches that never finished, and
 * machines tagged with this stack that runway has no record of.
 */
export async function sweep(deps: Deps): Promise<SweepResult> {
  const { config, state, github, log } = deps;
  const now = (deps.now ?? Date.now)();
  const result: SweepResult = { terminated: [], orphans: [] };
  const active = await state.activeRunners();
  const maxAgeMs = (config.maxJobMinutes + 15) * 60_000;

  for (const r of active) {
    const age = now - r.launchedAt;
    let reason: string | undefined;
    if (age > maxAgeMs) {
      reason = 'job time limit reached';
    } else if (r.state === 'launching' && age > 10 * 60_000) {
      reason = 'launch never completed';
    } else if (r.state === 'launched' && age > 3 * 60_000) {
      const status = await github
        .jobStatus(
          r.installationId,
          { owner: r.owner, repo: r.repo, ownerIsOrg: r.ownerIsOrg },
          r.jobId,
        )
        .catch(() => 'unknown');
      // Its job was cancelled, or another runner took it and nothing else has picked this one up.
      if (
        status === 'completed' ||
        (status !== 'queued' && status !== 'unknown' && age > 10 * 60_000)
      ) {
        reason = 'job no longer queued';
      }
    }
    if (!reason) continue;
    try {
      await terminate(r, deps, reason);
      if (r.runnerId) {
        await github
          .deleteRunner(
            r.installationId,
            { owner: r.owner, repo: r.repo, ownerIsOrg: r.ownerIsOrg },
            r.runnerId,
          )
          .catch(() => {});
      }
      result.terminated.push(r.pk);
    } catch (e) {
      log('sweep could not terminate', { runner: r.pk, error: (e as Error).message });
    }
  }

  const known = new Set(active.map((r) => r.resourceId).filter(Boolean));
  for (const [compute, provider] of Object.entries(deps.providers)) {
    let resources: Awaited<ReturnType<Provider['listManaged']>> = [];
    try {
      resources = await provider.listManaged();
    } catch (e) {
      log('sweep could not list resources', { compute, error: (e as Error).message });
      continue;
    }
    for (const res of resources) {
      if (known.has(res.resourceId) || now - res.startedAt < 15 * 60_000) continue;
      try {
        await provider.terminate(res.resourceId);
        result.orphans.push(res.resourceId);
        log('terminated orphan', { compute, resource: res.resourceId });
      } catch (e) {
        log('sweep could not terminate orphan', {
          compute,
          resource: res.resourceId,
          error: (e as Error).message,
        });
      }
    }
  }
  return result;
}
