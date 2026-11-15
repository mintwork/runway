// Building runner images, shared by the CLI (`runway setup` / `runway update`) and the weekly
// maintainer Lambda. Every build installs the latest GitHub Actions runner release, verified
// against the SHA-256 digests GitHub publishes for its release assets.
import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import {
  CreateMicrovmImageCommand,
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  ListMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
  UpdateMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, PutParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { strToU8, zipSync } from 'fflate';
import * as sources from '../generated/sources.js';
import { microvmImageKey } from '../providers/microvm.js';
import type { ImageRegistry } from './config.js';

export interface RunnerRelease {
  version: string;
  sha256: { arm64: string; x64: string };
}

type Fetch = typeof fetch;

async function latestRelease(
  repo: string,
  fetchImpl: Fetch,
): Promise<{ tag: string; assets: { name: string; digest?: string }[] }> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'mintwork-runway' },
  });
  if (!res.ok) throw new Error(`could not read the latest ${repo} release: ${res.status}`);
  const body = (await res.json()) as {
    tag_name: string;
    assets: { name: string; digest?: string }[];
  };
  return { tag: body.tag_name, assets: body.assets };
}

export async function latestRunner(fetchImpl: Fetch = fetch): Promise<RunnerRelease> {
  const rel = await latestRelease('actions/runner', fetchImpl);
  const version = rel.tag.replace(/^v/, '');
  const digest = (arch: string) => {
    const asset = rel.assets.find(
      (a) => a.name === `actions-runner-linux-${arch}-${version}.tar.gz`,
    );
    const d = asset?.digest?.replace(/^sha256:/, '');
    if (!d || !/^[0-9a-f]{64}$/.test(d))
      throw new Error(`no SHA-256 digest for the ${arch} runner ${version}`);
    return d;
  };
  return { version, sha256: { arm64: digest('arm64'), x64: digest('x64') } };
}

export async function latestCompose(fetchImpl: Fetch = fetch): Promise<string> {
  return (await latestRelease('docker/compose', fetchImpl)).tag;
}

/** The MicroVM build context: Dockerfile (with the runner pinned), agent and helper scripts. */
export function microvmZip(
  runner: RunnerRelease,
  composeVersion: string,
  runnerTools = '',
): Uint8Array {
  const dockerfile = sources.microvmDockerfile
    .replace('__RUNNER_VERSION__', runner.version)
    .replace('__RUNNER_SHA256_ARM64__', runner.sha256.arm64)
    .replace('__RUNNER_SHA256_X64__', runner.sha256.x64)
    .replace('__COMPOSE_VERSION__', composeVersion);
  return zipSync({
    Dockerfile: strToU8(dockerfile),
    'install-runner.sh': strToU8(sources.installRunner),
    'wait-for-docker.sh': [strToU8(sources.waitForDocker), { os: 3, attrs: 0o755 << 16 }],
    'runway_agent.py': strToU8(sources.agent),
    'runner-tools.sh': strToU8(runnerTools),
  });
}

/** The CodeBuild source for the Fargate and Lambda images. */
export function containerZip(runnerTools = ''): Uint8Array {
  return zipSync({
    'buildspec.yml': strToU8(sources.buildspec),
    'Dockerfile.fargate': strToU8(sources.fargateDockerfile),
    'Dockerfile.lambda': strToU8(sources.lambdaDockerfile),
    'install-runner.sh': strToU8(sources.installRunner),
    'runway_agent.py': strToU8(sources.agent),
    'runner-tools.sh': strToU8(runnerTools),
  });
}

export const RUNNER_TOOLS_KEY = 'runway/custom/runner-tools.sh';

/** Your runner-tools.sh from the data bucket, or '' when you haven't set one. */
export async function readRunnerTools(s3: S3Client, bucket: string): Promise<string> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: RUNNER_TOOLS_KEY }));
    return (await res.Body?.transformToString()) ?? '';
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return '';
    throw e;
  }
}

export interface ImageTargets {
  stack: string;
  region: string;
  bucket: string;
  /** e.g. ["arm64-1cpu"] */
  microvmSizes: string[];
  microvmBuildRoleArn: string;
  microvmLogGroup: string;
  codeBuildProjects: { arm64: string; x64: string };
  repositoryUri: string;
  imagesParam: string;
}

export const MICROVM_BASE_IMAGE = (region: string) =>
  `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;
export const microvmImageName = (stack: string, key: string) => `runway-${stack}-${key}`;

export interface BuildStarted {
  runner: RunnerRelease;
  microvm: Record<string, string>;
  /** The version that was active before this build, per image key, so waiting can tell old from new. */
  previousMicrovmVersions: Record<string, string | undefined>;
  codeBuildIds: string[];
}

/** Upload sources and start every image build. Returns as soon as the builds are running. */
export async function startImageBuilds(
  t: ImageTargets,
  clients = {
    s3: new S3Client({ region: t.region }),
    microvms: new LambdaMicrovmsClient({ region: t.region }),
    codebuild: new CodeBuildClient({ region: t.region }),
  },
  fetchImpl: Fetch = fetch,
): Promise<BuildStarted> {
  const runner = await latestRunner(fetchImpl);
  const compose = await latestCompose(fetchImpl);
  const runnerTools = await readRunnerTools(clients.s3, t.bucket);
  const microvmKey = `runway/images/microvm-${runner.version}.zip`;
  await clients.s3.send(
    new PutObjectCommand({
      Bucket: t.bucket,
      Key: microvmKey,
      Body: microvmZip(runner, compose, runnerTools),
    }),
  );
  await clients.s3.send(
    new PutObjectCommand({
      Bucket: t.bucket,
      Key: 'runway/images/container.zip',
      Body: containerZip(runnerTools),
    }),
  );

  const existing = new Map<string, string>();
  let nextToken: string | undefined;
  do {
    const page = await clients.microvms.send(new ListMicrovmImagesCommand({ nextToken }));
    for (const img of page.items ?? [])
      if (img.name && img.imageArn) existing.set(img.name, img.imageArn);
    nextToken = page.nextToken;
  } while (nextToken);

  const microvm: Record<string, string> = {};
  const previousMicrovmVersions: Record<string, string | undefined> = {};
  for (const key of t.microvmSizes) {
    const [arch, size] = key.split('-');
    const cpu = Number(size.replace('cpu', ''));
    const name = microvmImageName(t.stack, key);
    const common = {
      baseImageArn: MICROVM_BASE_IMAGE(t.region),
      buildRoleArn: t.microvmBuildRoleArn,
      codeArtifact: { uri: `s3://${t.bucket}/${microvmKey}` },
      description: `runway runner ${runner.version} (${key})`,
      logging: { cloudWatch: { logGroup: t.microvmLogGroup, logStream: `build-${key}` } },
      cpuConfigurations: [{ architecture: arch === 'x64' ? 'X86_64' : 'ARM_64' }] as never,
      resources: [{ minimumMemoryInMiB: cpu * 2048 }],
      additionalOsCapabilities: ['ALL'] as never,
      hooks: {
        port: 9000,
        microvmHooks: {
          run: 'ENABLED',
          runTimeoutInSeconds: 10,
          terminate: 'ENABLED',
          terminateTimeoutInSeconds: 10,
        },
        // /validate warms Docker on a fresh MicroVM so Lambda prefetches those snapshot pages.
        microvmImageHooks: {
          ready: 'ENABLED',
          readyTimeoutInSeconds: 600,
          validate: 'ENABLED',
          validateTimeoutInSeconds: 600,
        },
      } as never,
    };
    const arn = existing.get(name);
    if (arn) {
      previousMicrovmVersions[key] = (await microvmImageState(clients.microvms, arn)).active;
      await pruneMicrovmVersions(clients.microvms, arn, previousMicrovmVersions[key]);
      // Deleting versions puts the image into a transitional state; updates are refused until it settles.
      await waitForSettledImage(clients.microvms, arn, name);
      await clients.microvms.send(
        new UpdateMicrovmImageCommand({ imageIdentifier: arn, ...common }),
      );
      microvm[microvmImageKey(arch, cpu)] = arn;
    } else {
      const res = await clients.microvms.send(
        new CreateMicrovmImageCommand({ name, ...common, tags: { 'runway:stack': t.stack } }),
      );
      if (!res.imageArn) throw new Error(`create-microvm-image returned no ARN for ${name}`);
      microvm[microvmImageKey(arch, cpu)] = res.imageArn;
    }
  }

  const codeBuildIds: string[] = [];
  for (const arch of ['arm64', 'x64'] as const) {
    const res = await clients.codebuild.send(
      new StartBuildCommand({
        projectName: t.codeBuildProjects[arch],
        environmentVariablesOverride: [
          { name: 'RUNNER_VERSION', value: runner.version, type: 'PLAINTEXT' },
          { name: 'RUNNER_SHA256_ARM64', value: runner.sha256.arm64, type: 'PLAINTEXT' },
          { name: 'RUNNER_SHA256_X64', value: runner.sha256.x64, type: 'PLAINTEXT' },
        ],
      }),
    );
    if (res.build?.id) codeBuildIds.push(res.build.id);
  }
  return { runner, microvm, previousMicrovmVersions, codeBuildIds };
}

export async function readRegistry(
  ssm: SSMClient,
  param: string,
): Promise<ImageRegistry | undefined> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: param }));
    return JSON.parse(res.Parameter?.Value ?? '') as ImageRegistry;
  } catch (e) {
    if ((e as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw e;
  }
}

export async function writeRegistry(
  ssm: SSMClient,
  param: string,
  registry: ImageRegistry,
): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: param,
      Type: 'String',
      Overwrite: true,
      Value: JSON.stringify(registry),
    }),
  );
}

/** The registry after a build: new runner version, image ARNs merged, container tags fixed by convention. */
export function registryAfterBuild(
  previous: ImageRegistry | undefined,
  started: BuildStarted,
  repositoryUri: string,
): ImageRegistry {
  return {
    runner: started.runner,
    microvm: { ...(previous?.microvm ?? {}), ...started.microvm },
    fargate: { arm64: `${repositoryUri}:fargate-arm64`, x64: `${repositoryUri}:fargate-x64` },
    lambda: { arm64: `${repositoryUri}:lambda-arm64`, x64: `${repositoryUri}:lambda-x64` },
    updatedAt: new Date().toISOString(),
    build: {
      startedAt: new Date().toISOString(),
      codeBuildIds: started.codeBuildIds,
      previousMicrovmVersions: started.previousMicrovmVersions,
    },
  };
}

export async function microvmImageState(client: LambdaMicrovmsClient, arn: string) {
  const img = await client.send(new GetMicrovmImageCommand({ imageIdentifier: arn }));
  return {
    state: img.state,
    active: img.latestActiveImageVersion,
    failed: img.latestFailedImageVersion,
  };
}

/**
 * Image versions cost storage, and weekly rebuilds would pile them up. Before a rebuild, delete
 * every version except the active one, skipping any version a MicroVM is still running on.
 */
export async function pruneMicrovmVersions(
  client: LambdaMicrovmsClient,
  arn: string,
  active: string | undefined,
): Promise<string[]> {
  const versions: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new ListMicrovmImageVersionsCommand({ imageIdentifier: arn, nextToken }),
    );
    for (const v of page.items ?? []) {
      if (
        v.imageVersion &&
        v.imageVersion !== active &&
        v.state !== 'PENDING' &&
        v.state !== 'IN_PROGRESS'
      )
        versions.push(v.imageVersion);
    }
    nextToken = page.nextToken;
  } while (nextToken);
  const deleted: string[] = [];
  for (const version of versions) {
    const running = await client.send(
      new ListMicrovmsCommand({ imageIdentifier: arn, imageVersion: version }),
    );
    if ((running.items ?? []).some((vm) => vm.state !== 'TERMINATED')) continue;
    await client.send(
      new DeleteMicrovmImageVersionCommand({ imageIdentifier: arn, imageVersion: version }),
    );
    deleted.push(version);
  }
  return deleted;
}

const SETTLED = new Set(['CREATED', 'UPDATED', 'CREATE_FAILED', 'UPDATE_FAILED']);

export async function waitForSettledImage(
  client: LambdaMicrovmsClient,
  arn: string,
  name: string,
  timeoutMs = 5 * 60_000,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line security-node/detect-unhandled-async-errors -- errors propagate to the caller, which reports them
  for (;;) {
    const { state } = await microvmImageState(client, arn);
    if (state && SETTLED.has(state)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `MicroVM image ${name} is still ${state} (a build or cleanup is running); try again in a few minutes`,
      );
    }
    await sleep(5000);
  }
}
