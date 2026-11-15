// Lambda functions: the cheapest, fastest option for short jobs (lint, unit tests). A Lambda
// invocation can't exceed 15 minutes and has no Docker daemon. Memory (and so vCPU) is a
// function setting, not a per-invocation one, so there is one runner function per
// architecture and size, created on first use from the runner container image.
//
// Isolation: the agent ends its own process after the job, which makes Lambda discard the
// execution environment, so a later job can never land in a sandbox an earlier job touched.

import type { ECRClient } from '@aws-sdk/client-ecr';
import {
  CreateFunctionCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
} from '@aws-sdk/client-lambda';
import type { Config, ImageRegistry } from '../core/config.js';
import { containerImageReady, defaultEcr } from './readiness.js';
import {
  CapacityError,
  isCapacityError,
  type Launched,
  type LaunchRequest,
  type ManagedResource,
  NotReadyError,
  notReadyIfMissing,
  type Provider,
} from './types.js';

export const LAMBDA_TIMEOUT_SECONDS = 900;

export function runnerFunctionName(prefix: string, arch: string, memoryMb: number): string {
  return `${prefix}-${arch}-${memoryMb}`;
}

export class LambdaProvider implements Provider {
  readonly compute = 'lambda' as const;
  private ready = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly images: () => Promise<ImageRegistry>,
    private readonly client = new LambdaClient({ region: config.region }),
    private readonly sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    private readonly ecr: ECRClient = defaultEcr(config.region),
  ) {}

  /** Create the runner function for this size if it doesn't exist yet, and wait until it's Active. */
  async ensureFunction(arch: 'arm64' | 'x64', memoryMb: number): Promise<string> {
    const name = runnerFunctionName(this.config.lambda.functionPrefix, arch, memoryMb);
    if (this.ready.has(name)) return name;
    let state: string | undefined;
    try {
      state = (await this.client.send(new GetFunctionConfigurationCommand({ FunctionName: name })))
        .State;
    } catch (e) {
      if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
      const imageUri = (await this.images().catch((e) => notReadyIfMissing('lambda', e))).lambda[
        arch
      ];
      if (
        imageUri &&
        !(await containerImageReady(this.ecr, this.config.lambda.repositoryUri, `lambda-${arch}`))
      ) {
        throw new NotReadyError('lambda', `the ${arch} Lambda runner image is still being built`);
      }
      if (!imageUri)
        throw new CapacityError(
          'lambda',
          `no Lambda runner image for ${arch} yet. Run: npx -y @mintwork/runway update`,
        );
      await this.client.send(
        new CreateFunctionCommand({
          FunctionName: name,
          PackageType: 'Image',
          Code: { ImageUri: imageUri },
          Role: this.config.lambda.roleArn,
          Architectures: [arch === 'arm64' ? 'arm64' : 'x86_64'],
          MemorySize: memoryMb,
          Timeout: LAMBDA_TIMEOUT_SECONDS,
          EphemeralStorage: { Size: 10240 },
          Description: `runway runner (${arch}, ${memoryMb} MB) for stack ${this.config.stack}`,
          Tags: { 'runway:stack': this.config.stack },
        }),
      );
      state = 'Pending';
    }
    for (let i = 0; state === 'Pending' && i < 45; i++) {
      await this.sleep(2000);
      state = (await this.client.send(new GetFunctionConfigurationCommand({ FunctionName: name })))
        .State;
    }
    if (state !== 'Active')
      throw new CapacityError('lambda', `runner function ${name} is ${state}`);
    // Never retry an async invocation: a retried JIT config would be rejected anyway.
    await this.client.send(
      new PutFunctionEventInvokeConfigCommand({
        FunctionName: name,
        MaximumRetryAttempts: 0,
        MaximumEventAgeInSeconds: 60,
      }),
    );
    this.ready.add(name);
    return name;
  }

  async launch(req: LaunchRequest): Promise<Launched> {
    const memoryMb = Math.round(req.spec.memoryGb * 1024);
    try {
      const name = await this.ensureFunction(req.spec.arch, memoryMb);
      const res = await this.client.send(
        new InvokeCommand({
          FunctionName: name,
          InvocationType: 'Event',
          Payload: Buffer.from(
            JSON.stringify({ runnerName: req.runnerName, jitConfig: req.jitConfig }),
          ),
        }),
      );
      return {
        resourceId: `${name}#${res.$metadata.requestId ?? req.runnerName}`,
        detail: `${req.spec.arch} ${memoryMb} MB`,
      };
    } catch (e) {
      if (e instanceof CapacityError) throw e;
      if (isCapacityError(e) || (e as { name?: string }).name === 'TooManyRequestsException') {
        throw new CapacityError('lambda', (e as Error).message);
      }
      throw e;
    }
  }

  /** An async invocation can't be cancelled; it ends with the job or at the 15-minute limit. */
  async terminate(): Promise<void> {}

  async listManaged(): Promise<ManagedResource[]> {
    return [];
  }
}
