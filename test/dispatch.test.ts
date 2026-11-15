import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/core/config.js';
import {
  type Deps,
  fallbackChain,
  handleCompleted,
  handleInProgress,
  handleQueued,
  type QueuedJob,
  RetryLater,
  sweep,
} from '../src/core/dispatch.js';
import type { RunnerRecord } from '../src/core/state.js';
import { CapacityError, NotReadyError, type Provider } from '../src/providers/types.js';

const config = {
  stack: 'runway',
  defaultCompute: 'microvm',
  allowedOwners: ['acme'],
  allowPublicRepos: false,
  maxJobMinutes: 60,
  fallback: { microvm: 'ec2' },
} as unknown as Config;

const job: QueuedJob = {
  jobId: 11,
  runId: 22,
  labels: ['runway', 'microvm'],
  owner: 'acme',
  repo: 'api',
  ownerIsOrg: true,
  private: true,
  installationId: 33,
};

function fakeState(initial: RunnerRecord[] = []) {
  const runners = new Map(initial.map((r) => [r.pk, { ...r }]));
  const claimed = new Set<number>();
  const refusals: { jobId: number; reason: string }[] = [];
  return {
    runners,
    claimed,
    claimJob: vi.fn(async (jobId: number) => {
      if (claimed.has(jobId)) return false;
      claimed.add(jobId);
      return true;
    }),
    releaseJob: vi.fn(async (jobId: number) => {
      claimed.delete(jobId);
    }),
    putRunner: vi.fn(async (r: RunnerRecord) => {
      runners.set(r.pk, { ...r });
    }),
    getRunner: vi.fn(async (pk: string) => runners.get(pk)),
    update: vi.fn(async (pk: string, fields: Partial<RunnerRecord>) => {
      const r = runners.get(pk);
      if (r) runners.set(pk, { ...r, ...fields });
    }),
    refusals,
    recordRefusal: vi.fn(async function (this: unknown, r: { jobId: number; reason: string }) {
      refusals.push(r);
    }),
    activeRunners: vi.fn(async () =>
      [...runners.values()].filter((r) => ['launching', 'launched', 'busy'].includes(r.state)),
    ),
  };
}

function fakeProvider(
  compute: Provider['compute'],
  behavior: 'ok' | 'capacity' | 'error' | 'not-ready' = 'ok',
): Provider & { launch: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> } {
  return {
    compute,
    launch: vi.fn(async () => {
      if (behavior === 'capacity') throw new CapacityError(compute, 'quota');
      if (behavior === 'not-ready') throw new NotReadyError(compute, 'image still building');
      if (behavior === 'error') throw new Error('boom');
      return { resourceId: `${compute}-res`, detail: 'x' };
    }),
    terminate: vi.fn(async () => {}),
    listManaged: vi.fn(async () => []),
  };
}

function fakeGitHub() {
  return {
    createJitRunner: vi.fn(async () => ({ runnerId: 99, encodedJitConfig: 'JIT' })),
    deleteRunner: vi.fn(async () => {}),
    runIsFromFork: vi.fn(async () => false),
    jobStatus: vi.fn(async (_installationId: number, _ref: unknown, _jobId: number) => 'queued'),
    reportRefusal: vi.fn(
      async (_i: number, _r: unknown, _sha: string, _name: string, _reason: string) => {},
    ),
  };
}

interface Overrides {
  config?: Config;
  state?: ReturnType<typeof fakeState>;
  providers?: Deps['providers'];
  now?: () => number;
}

function deps(over: Overrides = {}) {
  return {
    config: over.config ?? config,
    github: fakeGitHub(),
    state: over.state ?? fakeState(),
    providers: over.providers ?? { microvm: fakeProvider('microvm'), ec2: fakeProvider('ec2') },
    log: vi.fn(),
    now: over.now ?? (() => 1_000_000),
    newRunnerName: () => 'runway-aaaa',
  };
}

describe('fallbackChain', () => {
  it('follows fallbacks and stops at loops', () => {
    expect(fallbackChain('microvm', { microvm: 'ec2', ec2: 'fargate' })).toEqual([
      'microvm',
      'ec2',
      'fargate',
    ]);
    expect(fallbackChain('ec2', { ec2: 'fargate', fargate: 'ec2' })).toEqual(['ec2', 'fargate']);
    expect(fallbackChain('lambda', {})).toEqual(['lambda']);
  });
});

describe('handleQueued', () => {
  it('registers a JIT runner and launches it on the requested compute', async () => {
    const d = deps();
    const out = await handleQueued(job, d);
    expect(out).toEqual({
      status: 'launched',
      runnerName: 'runway-aaaa',
      compute: 'microvm',
      resourceId: 'microvm-res',
    });
    expect(d.github.createJitRunner).toHaveBeenCalledWith(
      33,
      { owner: 'acme', repo: 'api', ownerIsOrg: true },
      'runway-aaaa',
      ['runway', 'microvm'],
    );
    const launch = (d.providers.microvm as ReturnType<typeof fakeProvider>).launch.mock.calls[0][0];
    expect(launch).toMatchObject({
      runnerName: 'runway-aaaa',
      jitConfig: 'JIT',
      maxSeconds: 3600,
      spec: { compute: 'microvm', cpu: 1 },
    });
    expect(d.state.runners.get('runway-aaaa')).toMatchObject({
      state: 'launched',
      runnerId: 99,
      resourceId: 'microvm-res',
      jobId: 11,
    });
  });

  it('ignores jobs without the runway label', async () => {
    const d = deps();
    expect(await handleQueued({ ...job, labels: ['ubuntu-latest'] }, d)).toEqual({
      status: 'ignored',
      reason: 'no runway label',
    });
    expect(d.github.createJitRunner).not.toHaveBeenCalled();
  });

  it('rejects owners outside AllowedOwners, public repos, forks and bad labels', async () => {
    expect(await handleQueued({ ...job, owner: 'mallory' }, deps())).toMatchObject({
      status: 'rejected',
      reason: 'owner mallory is not in AllowedOwners',
    });
    expect(await handleQueued({ ...job, private: false }, deps())).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('public repository'),
    });

    const pub = deps({ config: { ...config, allowPublicRepos: true } });
    pub.github.runIsFromFork.mockResolvedValue(true);
    expect(await handleQueued({ ...job, private: false }, pub)).toEqual({
      status: 'rejected',
      reason: 'workflow run from a fork',
    });

    const bad = deps();
    expect(await handleQueued({ ...job, labels: ['runway', '4cpus'] }, bad)).toMatchObject({
      status: 'rejected',
    });
    expect(bad.state.claimJob).not.toHaveBeenCalled();
    expect(bad.state.refusals).toMatchObject([
      { jobId: 11, reason: expect.stringContaining('unknown label "4cpus"') },
    ]);
  });

  it('explains a refusal on the commit, as a failed check', async () => {
    const d = deps();
    await handleQueued(
      { ...job, labels: ['runway', '4cpus'], headSha: 'abc123', jobName: 'build' },
      d,
    );
    expect(d.github.reportRefusal).toHaveBeenCalledWith(
      33,
      { owner: 'acme', repo: 'api', ownerIsOrg: true },
      'abc123',
      'build',
      expect.stringContaining('Did you mean "4cpu"?'),
    );
  });

  it('still refuses (and records why) when the check cannot be posted', async () => {
    const d = deps();
    d.github.reportRefusal.mockRejectedValue(
      new Error('403: Resource not accessible by integration'),
    );
    expect(await handleQueued({ ...job, private: false, headSha: 'abc' }, d)).toMatchObject({
      status: 'rejected',
    });
    expect(d.state.refusals).toHaveLength(1);
  });

  it('launches once when GitHub redelivers the webhook', async () => {
    const d = deps();
    await handleQueued(job, d);
    expect(await handleQueued(job, d)).toEqual({ status: 'duplicate' });
    expect(d.github.createJitRunner).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next compute type, resized for it', async () => {
    const d = deps({
      providers: { microvm: fakeProvider('microvm', 'capacity'), ec2: fakeProvider('ec2') },
    });
    const out = await handleQueued(job, d);
    expect(out).toMatchObject({ status: 'launched', compute: 'ec2', resourceId: 'ec2-res' });
    const spec = (d.providers.ec2 as ReturnType<typeof fakeProvider>).launch.mock.calls[0][0].spec;
    expect(spec).toMatchObject({ compute: 'ec2', arch: 'arm64', cpu: 2 });
    expect(d.state.runners.get('runway-aaaa')?.compute).toBe('ec2');
  });

  it('when nothing has capacity: removes the runner registration, frees the job and asks for a retry', async () => {
    const d = deps({
      providers: {
        microvm: fakeProvider('microvm', 'capacity'),
        ec2: fakeProvider('ec2', 'capacity'),
      },
    });
    await expect(handleQueued(job, d)).rejects.toBeInstanceOf(RetryLater);
    expect(d.github.deleteRunner).toHaveBeenCalledWith(33, expect.anything(), 99);
    expect(d.state.claimed.has(11)).toBe(false);
    expect(d.state.runners.get('runway-aaaa')).toMatchObject({
      state: 'failed',
      error: 'microvm: quota | ec2: quota',
    });
  });

  it('waits for an image that is still building, instead of falling back', async () => {
    const ec2 = fakeProvider('ec2');
    const d = deps({ providers: { microvm: fakeProvider('microvm', 'not-ready'), ec2 } });
    await expect(handleQueued(job, d)).rejects.toBeInstanceOf(RetryLater);
    expect(ec2.launch).not.toHaveBeenCalled();
    expect(d.state.claimed.has(11)).toBe(false);
    expect(d.github.deleteRunner).toHaveBeenCalled();
  });

  it('records what it needs to queue the job again', async () => {
    const d = deps();
    await handleQueued({ ...job, headSha: 'abc', jobName: 'build' }, d);
    expect(d.state.runners.get('runway-aaaa')).toMatchObject({
      labels: ['runway', 'microvm'],
      private: true,
      headSha: 'abc',
      jobName: 'build',
    });
  });

  it('cleans up the same way on an unexpected error, and rethrows it', async () => {
    const d = deps({ providers: { microvm: fakeProvider('microvm', 'error') } });
    await expect(handleQueued(job, d)).rejects.toThrow('boom');
    expect(d.github.deleteRunner).toHaveBeenCalled();
    expect(d.state.claimed.has(11)).toBe(false);
  });
});

const record = (over: Partial<RunnerRecord> = {}): RunnerRecord => ({
  pk: 'runway-aaaa',
  compute: 'microvm',
  resourceId: 'vm-1',
  owner: 'acme',
  repo: 'api',
  ownerIsOrg: true,
  installationId: 33,
  jobId: 11,
  runId: 22,
  runnerId: 99,
  state: 'launched',
  launchedAt: 1_000_000,
  ttl: 0,
  ...over,
});

describe('in_progress and completed', () => {
  it('marks the runner busy with the job it actually took', async () => {
    const d = deps({ state: fakeState([record()]) });
    await handleInProgress('runway-aaaa', 12, d);
    expect(d.state.runners.get('runway-aaaa')).toMatchObject({ state: 'busy', busyJobId: 12 });
  });

  it('terminates the machine when the job completes, once', async () => {
    const d = deps({ state: fakeState([record()]) });
    await handleCompleted('runway-aaaa', d);
    await handleCompleted('runway-aaaa', d);
    expect(
      (d.providers.microvm as ReturnType<typeof fakeProvider>).terminate,
    ).toHaveBeenCalledTimes(1);
    expect(d.state.runners.get('runway-aaaa')?.state).toBe('done');
  });

  it('ignores runners runway did not launch', async () => {
    const d = deps();
    await handleCompleted('my-own-runner', d);
    await handleInProgress('my-own-runner', 1, d);
    expect(d.state.getRunner).not.toHaveBeenCalled();
  });
});

describe('sweep', () => {
  const minutes = (m: number) => 1_000_000 + m * 60_000;

  it('ends runners past the job time limit and launches that never finished', async () => {
    const d = deps({
      state: fakeState([
        record({ pk: 'runway-old', state: 'busy' }),
        record({ pk: 'runway-stuck', state: 'launching', resourceId: undefined }),
      ]),
      now: () => minutes(80),
    });
    const res = await sweep(d);
    expect(res.terminated.sort()).toEqual(['runway-old', 'runway-stuck']);
    expect(d.state.runners.get('runway-old')).toMatchObject({
      state: 'done',
      error: 'job time limit reached',
    });
  });

  it('ends an idle runner whose job was cancelled, but not a busy one or one still waiting', async () => {
    const state = fakeState([
      record({ pk: 'runway-idle', resourceId: 'vm-idle' }),
      record({ pk: 'runway-busy', state: 'busy', resourceId: 'vm-busy' }),
      record({ pk: 'runway-wait', jobId: 12, resourceId: 'vm-wait' }),
    ]);
    const microvm = fakeProvider('microvm');
    (microvm.listManaged as ReturnType<typeof vi.fn>).mockResolvedValue(
      ['vm-idle', 'vm-busy', 'vm-wait'].map((resourceId) => ({
        resourceId,
        startedAt: minutes(0),
      })),
    );
    const d = deps({ state, providers: { microvm }, now: () => minutes(5) });
    d.github.jobStatus.mockImplementation(async (_i: number, _r: unknown, jobId: number) =>
      jobId === 11 ? 'completed' : 'queued',
    );
    const res = await sweep(d);
    expect(res.terminated).toEqual(['runway-idle']);
    expect(d.github.deleteRunner).toHaveBeenCalledWith(33, expect.anything(), 99);
  });

  it('ends idle runners whose job another runner took, after 10 minutes', async () => {
    const d = deps({ state: fakeState([record()]), now: () => minutes(6) });
    d.github.jobStatus.mockResolvedValue('in_progress');
    expect((await sweep(d)).terminated).toEqual([]);
    d.now = () => minutes(11);
    expect((await sweep(d)).terminated).toEqual(['runway-aaaa']);
  });

  it('queues a job again when its machine stopped before taking it', async () => {
    const microvm = fakeProvider('microvm');
    const requeue = vi.fn(async () => {});
    const state = fakeState([record({ labels: ['runway', 'microvm'], private: true })]);
    state.claimed.add(11);
    const d = deps({ state, providers: { microvm }, now: () => minutes(4) });
    Object.assign(d, { requeue });
    const res = await sweep(d);
    expect(res.relaunched).toEqual([11]);
    expect(requeue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 11,
        labels: ['runway', 'microvm'],
        private: true,
        installationId: 33,
      }),
    );
    expect(state.claimed.has(11)).toBe(false);
    expect(state.runners.get('runway-aaaa')).toMatchObject({
      state: 'done',
      error: 'machine stopped before it took the job',
    });
  });

  it('leaves a runner alone while its machine is still there, and never re-queues Lambda runners', async () => {
    const microvm = fakeProvider('microvm');
    (microvm.listManaged as ReturnType<typeof vi.fn>).mockResolvedValue([
      { resourceId: 'vm-1', startedAt: minutes(0) },
    ]);
    const requeue = vi.fn(async () => {});
    const d = deps({
      state: fakeState([
        record({ labels: ['runway'] }),
        record({ pk: 'runway-l', compute: 'lambda', resourceId: 'fn#1', labels: ['runway'] }),
      ]),
      providers: { microvm },
      now: () => minutes(4),
    });
    Object.assign(d, { requeue });
    expect((await sweep(d)).relaunched).toEqual([]);
    expect(requeue).not.toHaveBeenCalled();
  });

  it('does not re-queue when the machine list could not be read', async () => {
    const microvm = fakeProvider('microvm');
    (microvm.listManaged as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('throttled'));
    const requeue = vi.fn(async () => {});
    const d = deps({
      state: fakeState([record({ labels: ['runway'] })]),
      providers: { microvm },
      now: () => minutes(4),
    });
    Object.assign(d, { requeue });
    expect((await sweep(d)).relaunched).toEqual([]);
  });

  it('terminates tagged machines runway has no record of, after a grace period', async () => {
    const microvm = fakeProvider('microvm');
    (microvm.listManaged as ReturnType<typeof vi.fn>).mockResolvedValue([
      { resourceId: 'vm-1', startedAt: minutes(0) },
      { resourceId: 'vm-orphan', startedAt: minutes(0) },
      { resourceId: 'vm-new', startedAt: minutes(25) },
    ]);
    const d = deps({
      state: fakeState([record({ state: 'busy' })]),
      providers: { microvm },
      now: () => minutes(30),
    });
    const res = await sweep(d);
    expect(res.orphans).toEqual(['vm-orphan']);
    expect(microvm.terminate).toHaveBeenCalledTimes(1);
  });
});
