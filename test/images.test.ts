import {
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmImageVersionsCommand,
  ListMicrovmsCommand,
} from '@aws-sdk/client-lambda-microvms';
import { mockClient } from 'aws-sdk-client-mock';
import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  containerZip,
  latestRunner,
  microvmZip,
  pruneMicrovmVersions,
  waitForSettledImage,
} from '../src/core/images.js';

const release = {
  tag_name: 'v2.338.2',
  assets: [
    { name: 'actions-runner-linux-arm64-2.338.2.tar.gz', digest: `sha256:${'a'.repeat(64)}` },
    { name: 'actions-runner-linux-x64-2.338.2.tar.gz', digest: `sha256:${'b'.repeat(64)}` },
  ],
};

describe('latestRunner', () => {
  it('reads the version and the SHA-256 digests GitHub publishes', async () => {
    const runner = await latestRunner(async () => new Response(JSON.stringify(release)));
    expect(runner).toEqual({
      version: '2.338.2',
      sha256: { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) },
    });
  });

  it('refuses a release without digests rather than installing an unverified runner', async () => {
    const noDigest = { ...release, assets: release.assets.map(({ name }) => ({ name })) };
    await expect(latestRunner(async () => new Response(JSON.stringify(noDigest)))).rejects.toThrow(
      'no SHA-256 digest',
    );
  });
});

describe('image build contexts', () => {
  it('pins the runner version and digests into the MicroVM Dockerfile', () => {
    const files = unzipSync(
      microvmZip(
        { version: '2.338.2', sha256: { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) } },
        'v5.7.1',
      ),
    );
    expect(Object.keys(files).sort()).toEqual([
      'Dockerfile',
      'install-runner.sh',
      'runway_agent.py',
      'wait-for-docker.sh',
    ]);
    const dockerfile = strFromU8(files.Dockerfile);
    expect(dockerfile).toContain('ARG RUNNER_VERSION=2.338.2');
    expect(dockerfile).toContain(`ARG RUNNER_SHA256_X64=${'b'.repeat(64)}`);
    expect(dockerfile).toContain('ARG COMPOSE_VERSION=v5.7.1');
    expect(dockerfile).not.toContain('__');
  });

  it('ships the buildspec and both Dockerfiles to CodeBuild', () => {
    expect(Object.keys(unzipSync(containerZip())).sort()).toEqual([
      'Dockerfile.fargate',
      'Dockerfile.lambda',
      'buildspec.yml',
      'install-runner.sh',
      'runway_agent.py',
    ]);
  });
});

describe('pruneMicrovmVersions', () => {
  const mvm = mockClient(LambdaMicrovmsClient);
  beforeEach(() => mvm.reset());

  it('keeps the active version, builds in progress, and versions a MicroVM still runs on', async () => {
    mvm.on(ListMicrovmImageVersionsCommand).resolves({
      items: [
        { imageVersion: '1.0', state: 'SUCCESSFUL' },
        { imageVersion: '2.0', state: 'SUCCESSFUL' },
        { imageVersion: '3.0', state: 'SUCCESSFUL' },
        { imageVersion: '4.0', state: 'FAILED' },
        { imageVersion: '5.0', state: 'IN_PROGRESS' },
      ] as never,
    });
    mvm.on(ListMicrovmsCommand).resolves({ items: [] });
    mvm
      .on(ListMicrovmsCommand, { imageVersion: '2.0' })
      .resolves({ items: [{ microvmId: 'vm', state: 'RUNNING' }] as never });
    const deleted = await pruneMicrovmVersions(new LambdaMicrovmsClient({}), 'arn:image', '3.0');
    expect(deleted).toEqual(['1.0', '4.0']);
    expect(
      mvm.commandCalls(DeleteMicrovmImageVersionCommand).map((c) => c.args[0].input.imageVersion),
    ).toEqual(['1.0', '4.0']);
  });
});

describe('waitForSettledImage', () => {
  const mvm = mockClient(LambdaMicrovmsClient);
  beforeEach(() => mvm.reset());

  it('waits while the image is updating, then returns', async () => {
    mvm
      .on(GetMicrovmImageCommand)
      .resolvesOnce({ state: 'UPDATING' } as never)
      .resolves({ state: 'UPDATED' } as never);
    await waitForSettledImage(new LambdaMicrovmsClient({}), 'arn', 'img', 60_000, async () => {});
    expect(mvm.commandCalls(GetMicrovmImageCommand)).toHaveLength(2);
  });

  it('gives up with a clear message instead of a raw API error', async () => {
    mvm.on(GetMicrovmImageCommand).resolves({ state: 'UPDATING' } as never);
    await expect(
      waitForSettledImage(new LambdaMicrovmsClient({}), 'arn', 'img', -1, async () => {}),
    ).rejects.toThrow('still UPDATING');
  });
});
