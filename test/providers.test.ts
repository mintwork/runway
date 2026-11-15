import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import {
  CreateFunctionCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
} from '@aws-sdk/client-lambda';
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Config, type ImageRegistry, loadConfig } from '../src/core/config.js';
import { parseLabels } from '../src/core/labels.js';
import { toMessage } from '../src/lambda/webhook.js';
import { Ec2Provider, userData } from '../src/providers/ec2.js';
import { FargateProvider } from '../src/providers/fargate.js';
import { LambdaProvider } from '../src/providers/lambda.js';
import { MicrovmProvider } from '../src/providers/microvm.js';
import { CapacityError } from '../src/providers/types.js';

const config: Config = loadConfig({
  RUNWAY_STACK: 'runway',
  AWS_REGION: 'eu-central-1',
  RUNWAY_TABLE: 't',
  RUNWAY_QUEUE_URL: 'q',
  RUNWAY_APP_PARAM: '/runway/runway/github-app',
  RUNWAY_IMAGES_PARAM: '/runway/runway/images',
  RUNWAY_FALLBACK: 'microvm:ec2',
  RUNWAY_SUBNETS: 'subnet-a,subnet-b',
  RUNWAY_SECURITY_GROUP: 'sg-1',
  RUNWAY_MICROVM_EXEC_ROLE: 'arn:exec',
  RUNWAY_MICROVM_EGRESS: 'arn:egress',
  RUNWAY_MICROVM_LOG_GROUP: '/runway/runway/microvm',
  RUNWAY_EC2_INSTANCE_PROFILE: 'arn:profile',
  RUNWAY_EC2_AGENT_URI: 's3://bucket/agent.py',
  RUNWAY_ECS_CLUSTER: 'cluster',
  RUNWAY_FARGATE_TASKDEF_ARM64: 'td-arm64',
  RUNWAY_FARGATE_TASKDEF_X64: 'td-x64',
  RUNWAY_LAMBDA_RUNNER_ROLE: 'arn:lambda-role',
  RUNWAY_ECR_REPOSITORY: 'repo',
});

const registry: ImageRegistry = {
  runner: { version: '2.338.2', sha256: { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) } },
  microvm: { 'arm64-1cpu': 'arn:image-1cpu' },
  fargate: {},
  lambda: { arm64: 'repo:lambda-arm64', x64: 'repo:lambda-x64' },
  updatedAt: '2026-11-15T00:00:00Z',
};
const images = async () => registry;
const spec = (...labels: string[]) => {
  const r = parseLabels(['runway', ...labels], { compute: 'microvm' });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
};
const req = (s: ReturnType<typeof spec>) => ({
  runnerName: 'runway-abc',
  jitConfig: 'JIT',
  spec: s,
  maxSeconds: 3600,
});
const awsError = (name: string, message = name) => Object.assign(new Error(message), { name });

describe('MicrovmProvider', () => {
  const mvm = mockClient(LambdaMicrovmsClient);
  beforeEach(() => mvm.reset());

  it('runs the image for the size with the JIT config in the run-hook payload', async () => {
    mvm.on(RunMicrovmCommand).resolves({ microvmId: 'vm-1' } as never);
    const p = new MicrovmProvider(config, images, new LambdaMicrovmsClient({}));
    expect(await p.launch(req(spec('microvm')))).toEqual({
      resourceId: 'vm-1',
      detail: 'arm64-1cpu',
    });
    const input = mvm.commandCalls(RunMicrovmCommand)[0].args[0].input;
    expect(input).toMatchObject({
      imageIdentifier: 'arn:image-1cpu',
      executionRoleArn: 'arn:exec',
      egressNetworkConnectors: ['arn:egress'],
      maximumDurationInSeconds: 3600,
      clientToken: 'runway-abc',
    });
    expect(JSON.parse(input.runHookPayload as string)).toEqual({
      runnerName: 'runway-abc',
      jitConfig: 'JIT',
    });
  });

  it('caps the session at 8 hours', async () => {
    mvm.on(RunMicrovmCommand).resolves({ microvmId: 'vm-1' } as never);
    await new MicrovmProvider(config, images, new LambdaMicrovmsClient({})).launch({
      ...req(spec('microvm')),
      maxSeconds: 48 * 3600,
    });
    expect(mvm.commandCalls(RunMicrovmCommand)[0].args[0].input.maximumDurationInSeconds).toBe(
      8 * 3600,
    );
  });

  it('turns a quota error or a missing image size into a CapacityError (so the job falls back)', async () => {
    mvm
      .on(RunMicrovmCommand)
      .rejects(awsError('ServiceQuotaExceededException', 'memory quota exceeded'));
    const p = new MicrovmProvider(config, images, new LambdaMicrovmsClient({}));
    await expect(p.launch(req(spec('microvm')))).rejects.toBeInstanceOf(CapacityError);
    await expect(p.launch(req(spec('microvm', '4cpu')))).rejects.toThrow(
      'no MicroVM image for arm64-4cpu',
    );
  });

  it('treats terminating an already-gone MicroVM as done', async () => {
    mvm.on(TerminateMicrovmCommand).rejects(awsError('ResourceNotFoundException'));
    await expect(
      new MicrovmProvider(config, images, new LambdaMicrovmsClient({})).terminate('vm-1'),
    ).resolves.toBeUndefined();
  });
});

describe('Ec2Provider', () => {
  const ec2 = mockClient(EC2Client);
  beforeEach(() => ec2.reset());

  it('launches a tagged, self-terminating instance with IMDSv2 and an encrypted disk', async () => {
    ec2.on(RunInstancesCommand).resolves({ Instances: [{ InstanceId: 'i-1' }] });
    const res = await new Ec2Provider(config, images, new EC2Client({})).launch(
      req(spec('ec2', 'arm64', '4cpu', 'disk-50gb')),
    );
    expect(res).toEqual({ resourceId: 'i-1', detail: 'm8g.xlarge on-demand' });
    const input = ec2.commandCalls(RunInstancesCommand)[0].args[0].input;
    expect(input).toMatchObject({
      ImageId: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
      InstanceType: 'm8g.xlarge',
      InstanceInitiatedShutdownBehavior: 'terminate',
      MetadataOptions: { HttpTokens: 'required' },
      BlockDeviceMappings: [{ Ebs: { VolumeSize: 50, Encrypted: true } }],
    });
    expect(input.TagSpecifications?.[0].Tags).toContainEqual({
      Key: 'runway:stack',
      Value: 'runway',
    });
    expect(input.InstanceMarketOptions).toBeUndefined();
  });

  it('tries Spot across instance types, then on-demand', async () => {
    ec2
      .on(RunInstancesCommand)
      .rejects(awsError('InsufficientInstanceCapacity'))
      .on(RunInstancesCommand, { InstanceType: 'm7i.large', InstanceMarketOptions: undefined })
      .resolves({ Instances: [{ InstanceId: 'i-2' }] });
    const res = await new Ec2Provider(
      { ...config, subnets: ['subnet-a'] },
      images,
      new EC2Client({}),
    ).launch(req(spec('ec2', 'spot')));
    expect(res).toEqual({ resourceId: 'i-2', detail: 'm7i.large on-demand' });
    const calls = ec2
      .commandCalls(RunInstancesCommand)
      .map(
        (c) =>
          `${c.args[0].input.InstanceType}/${c.args[0].input.InstanceMarketOptions ? 'spot' : 'od'}`,
      );
    expect(calls.slice(0, 2)).toEqual(['m7i.large/spot', 'm7a.large/spot']);
    expect(calls.at(-1)).toBe('m7i.large/od');
  });

  it('reports a CapacityError when nothing anywhere has capacity', async () => {
    ec2.on(RunInstancesCommand).rejects(awsError('InsufficientInstanceCapacity'));
    await expect(
      new Ec2Provider(config, images, new EC2Client({})).launch(req(spec('c7g.large'))),
    ).rejects.toBeInstanceOf(CapacityError);
    expect(ec2.commandCalls(RunInstancesCommand)).toHaveLength(2); // one type, two subnets
  });

  it('rethrows real errors instead of falling back', async () => {
    ec2.on(RunInstancesCommand).rejects(awsError('UnauthorizedOperation'));
    await expect(
      new Ec2Provider(config, images, new EC2Client({})).launch(req(spec('ec2'))),
    ).rejects.toThrow('UnauthorizedOperation');
  });

  it('terminates by id and lists only this stack', async () => {
    ec2.on(TerminateInstancesCommand).rejects(awsError('InvalidInstanceID.NotFound'));
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: 'i-9', LaunchTime: new Date(5000) }] }],
    });
    const p = new Ec2Provider(config, images, new EC2Client({}));
    await expect(p.terminate('i-9')).resolves.toBeUndefined();
    expect(await p.listManaged()).toEqual([{ resourceId: 'i-9', startedAt: 5000 }]);
    expect(ec2.commandCalls(DescribeInstancesCommand)[0].args[0].input.Filters?.[0]).toEqual({
      Name: 'tag:runway:stack',
      Values: ['runway'],
    });
  });
});

describe('userData', () => {
  const script = userData({
    runnerName: 'runway-abc',
    jitConfig: "it's-JIT",
    arch: 'x64',
    runnerVersion: '2.338.2',
    runnerSha256: 'b'.repeat(64),
    agentS3Uri: 's3://bucket/agent.py',
    maxMinutes: 60,
  });

  it('always shuts down, even when a step fails, and has a hard time limit', () => {
    expect(script).toContain('trap \'echo "runway: shutting down"; shutdown -h now\' EXIT');
    expect(script).toContain('shutdown -h +60');
  });

  it('verifies the runner download and quotes the JIT config safely', () => {
    expect(script).toContain('actions-runner-linux-x64-2.338.2.tar.gz');
    expect(script).toContain(`echo "${'b'.repeat(64)}  runner.tgz" | sha256sum -c -`);
    expect(script).toContain(`RUNWAY_JIT_CONFIG='it'\\''s-JIT'`);
  });
});

describe('FargateProvider', () => {
  const ecs = mockClient(ECSClient);
  beforeEach(() => ecs.reset());

  it('sizes the task per job and passes the JIT config to the runner container', async () => {
    ecs.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn:task' }] });
    await new FargateProvider(config, new ECSClient({})).launch(
      req(spec('fargate', 'arm64', '4cpu', '16gb', 'disk-60gb')),
    );
    const input = ecs.commandCalls(RunTaskCommand)[0].args[0].input;
    expect(input).toMatchObject({
      taskDefinition: 'td-arm64',
      launchType: 'FARGATE',
      startedBy: 'runway',
    });
    expect(input.overrides).toMatchObject({
      cpu: '4096',
      memory: '16384',
      ephemeralStorage: { sizeInGiB: 60 },
    });
    expect(input.overrides?.containerOverrides?.[0].environment).toContainEqual({
      name: 'RUNWAY_JIT_CONFIG',
      value: 'JIT',
    });
    expect(input.networkConfiguration?.awsvpcConfiguration).toMatchObject({
      subnets: ['subnet-a', 'subnet-b'],
      assignPublicIp: 'ENABLED',
    });
  });

  it('turns RunTask failures into a CapacityError', async () => {
    ecs
      .on(RunTaskCommand)
      .resolves({ tasks: [], failures: [{ reason: 'Capacity is unavailable at this time' }] });
    await expect(
      new FargateProvider(config, new ECSClient({})).launch(req(spec('fargate'))),
    ).rejects.toThrow('Capacity is unavailable');
  });
});

describe('LambdaProvider', () => {
  const lambda = mockClient(LambdaClient);
  beforeEach(() => lambda.reset());

  it('creates the runner function for the size on first use, waits until Active, then invokes async', async () => {
    let state = 'missing';
    lambda.on(GetFunctionConfigurationCommand).callsFake(async () => {
      if (state === 'missing') throw awsError('ResourceNotFoundException');
      state = 'Active';
      return { State: 'Active' };
    });
    lambda.on(CreateFunctionCommand).callsFake(async () => {
      state = 'Pending';
      return {};
    });
    lambda.on(InvokeCommand).resolves({ $metadata: { requestId: 'req-1' } } as never);
    const p = new LambdaProvider(config, images, new LambdaClient({}), async () => {});
    const res = await p.launch(req(spec('lambda', '2cpu')));
    expect(res.resourceId).toBe('runway-runway-runner-arm64-3538#req-1');
    expect(lambda.commandCalls(CreateFunctionCommand)[0].args[0].input).toMatchObject({
      FunctionName: 'runway-runway-runner-arm64-3538',
      PackageType: 'Image',
      Code: { ImageUri: 'repo:lambda-arm64' },
      MemorySize: 3538,
      Timeout: 900,
      Architectures: ['arm64'],
    });
    expect(
      lambda.commandCalls(PutFunctionEventInvokeConfigCommand)[0].args[0].input
        .MaximumRetryAttempts,
    ).toBe(0);
    const invoke = lambda.commandCalls(InvokeCommand)[0].args[0].input;
    expect(invoke.InvocationType).toBe('Event');
    expect(JSON.parse(Buffer.from(invoke.Payload as Uint8Array).toString())).toEqual({
      runnerName: 'runway-abc',
      jitConfig: 'JIT',
    });

    await p.launch(req(spec('lambda', '2cpu')));
    expect(lambda.commandCalls(CreateFunctionCommand)).toHaveLength(1);
  });

  it('treats Lambda throttling as no capacity', async () => {
    lambda.on(GetFunctionConfigurationCommand).resolves({ State: 'Active' });
    lambda.on(InvokeCommand).rejects(awsError('TooManyRequestsException', 'Rate exceeded'));
    await expect(
      new LambdaProvider(config, images, new LambdaClient({})).launch(req(spec('lambda'))),
    ).rejects.toBeInstanceOf(CapacityError);
  });
});

describe('webhook toMessage', () => {
  const event = (action: string, job: Record<string, unknown> = {}) => ({
    action,
    workflow_job: { id: 1, run_id: 2, labels: ['runway', 'ec2'], runner_name: null, ...job },
    repository: { name: 'api', private: true, owner: { login: 'acme', type: 'Organization' } },
    installation: { id: 3 },
  });

  it('queues runway jobs with what the worker needs', () => {
    expect(toMessage(event('queued'))).toEqual({
      type: 'queued',
      jobId: 1,
      runId: 2,
      labels: ['runway', 'ec2'],
      owner: 'acme',
      repo: 'api',
      ownerIsOrg: true,
      private: true,
      installationId: 3,
    });
  });

  it('ignores jobs for other runners, and progress events for runners runway did not start', () => {
    expect(toMessage(event('queued', { labels: ['ubuntu-latest'] }))).toBeUndefined();
    expect(toMessage(event('completed', { runner_name: 'GitHub Actions 2' }))).toBeUndefined();
    expect(toMessage(event('completed', { runner_name: 'runway-abc' }))).toEqual({
      type: 'completed',
      runnerName: 'runway-abc',
      jobId: 1,
    });
    expect(toMessage(event('waiting'))).toBeUndefined();
  });
});
