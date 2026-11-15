// Runtime configuration for the Lambda functions, read from environment variables that
// the CloudFormation stack sets. Every name is listed here so the template and the code
// can't drift apart silently: a missing required variable throws at cold start.
import type { Compute } from './labels.js';
import { COMPUTES } from './labels.js';

export interface Config {
  stack: string;
  region: string;
  table: string;
  queueUrl: string;
  appParam: string;
  imagesParam: string;
  assetsBucket: string;
  defaultCompute: Compute;
  allowedOwners: string[];
  allowPublicRepos: boolean;
  maxJobMinutes: number;
  /** compute -> next compute to try when the first has no capacity. */
  fallback: Partial<Record<Compute, Compute>>;
  subnets: string[];
  securityGroup: string;
  microvm: { execRoleArn: string; egressConnector: string; logGroup: string };
  ec2: {
    instanceProfileArn: string;
    agentS3Uri: string;
    runnerToolsS3Uri: string;
    logGroup: string;
  };
  fargate: { cluster: string; taskDefArm64: string; taskDefX64: string };
  lambda: { roleArn: string; repositoryUri: string; functionPrefix: string };
}

type Env = Record<string, string | undefined>;

function req(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

export function parseFallback(value: string | undefined): Partial<Record<Compute, Compute>> {
  const out: Partial<Record<Compute, Compute>> = {};
  for (const pair of (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [from, to] = pair.split(':').map((s) => s.trim()) as [Compute, Compute];
    if (!COMPUTES.includes(from) || !COMPUTES.includes(to) || from === to) {
      throw new Error(`bad fallback "${pair}": use pairs like microvm:ec2`);
    }
    out[from] = to;
  }
  return out;
}

export function loadConfig(env: Env = process.env): Config {
  const defaultCompute = (env.RUNWAY_DEFAULT_COMPUTE ?? 'microvm') as Compute;
  if (!COMPUTES.includes(defaultCompute))
    throw new Error(`bad RUNWAY_DEFAULT_COMPUTE ${defaultCompute}`);
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    stack: req(env, 'RUNWAY_STACK'),
    region: req(env, 'AWS_REGION'),
    table: req(env, 'RUNWAY_TABLE'),
    queueUrl: req(env, 'RUNWAY_QUEUE_URL'),
    appParam: req(env, 'RUNWAY_APP_PARAM'),
    imagesParam: req(env, 'RUNWAY_IMAGES_PARAM'),
    assetsBucket: env.RUNWAY_ASSETS_BUCKET ?? '',
    defaultCompute,
    allowedOwners: list(env.RUNWAY_ALLOWED_OWNERS).map((o) => o.toLowerCase()),
    allowPublicRepos: env.RUNWAY_ALLOW_PUBLIC_REPOS === 'true',
    maxJobMinutes: Number(env.RUNWAY_MAX_JOB_MINUTES ?? 360),
    fallback: parseFallback(env.RUNWAY_FALLBACK),
    subnets: list(env.RUNWAY_SUBNETS),
    securityGroup: env.RUNWAY_SECURITY_GROUP ?? '',
    microvm: {
      execRoleArn: env.RUNWAY_MICROVM_EXEC_ROLE ?? '',
      egressConnector: env.RUNWAY_MICROVM_EGRESS ?? '',
      logGroup: env.RUNWAY_MICROVM_LOG_GROUP ?? '',
    },
    ec2: {
      instanceProfileArn: env.RUNWAY_EC2_INSTANCE_PROFILE ?? '',
      agentS3Uri: env.RUNWAY_EC2_AGENT_URI ?? '',
      runnerToolsS3Uri: env.RUNWAY_RUNNER_TOOLS_URI ?? '',
      logGroup: env.RUNWAY_EC2_LOG_GROUP ?? '',
    },
    fargate: {
      cluster: env.RUNWAY_ECS_CLUSTER ?? '',
      taskDefArm64: env.RUNWAY_FARGATE_TASKDEF_ARM64 ?? '',
      taskDefX64: env.RUNWAY_FARGATE_TASKDEF_X64 ?? '',
    },
    lambda: {
      roleArn: env.RUNWAY_LAMBDA_RUNNER_ROLE ?? '',
      repositoryUri: env.RUNWAY_ECR_REPOSITORY ?? '',
      functionPrefix: env.RUNWAY_LAMBDA_RUNNER_PREFIX ?? `runway-${env.RUNWAY_STACK}-runner`,
    },
  };
}

/** What the CLI and maintainer write after building images; the worker reads it. */
export interface ImageRegistry {
  runner: { version: string; sha256: { arm64: string; x64: string } };
  /** Key: `${arch}-${cpu}cpu`, value: MicroVM image ARN. */
  microvm: Record<string, string>;
  /** Key: arch, value: ECR image URI with tag. Fargate and Lambda images. */
  fargate: Partial<Record<'arm64' | 'x64', string>>;
  lambda: Partial<Record<'arm64' | 'x64', string>>;
  updatedAt: string;
  /** The latest build, so the CLI can follow builds the maintainer started. */
  build?: {
    startedAt: string;
    codeBuildIds: string[];
    previousMicrovmVersions: Record<string, string | undefined>;
  };
}
