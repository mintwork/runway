// Lambda MicroVMs: one Firecracker VM per job, resumed from a snapshot of our runner image.
// The VM's lifecycle-hook server (agent/runway_agent.py) receives the JIT config in the
// /run hook payload, runs exactly one job, and the dispatcher terminates the VM when the
// job completes. maximumDurationInSeconds is the hard backstop.
import {
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import type { Config, ImageRegistry } from '../core/config.js';
import {
  CapacityError,
  isCapacityError,
  type Launched,
  type LaunchRequest,
  type ManagedResource,
  type Provider,
} from './types.js';

/** Lambda MicroVM sessions are capped at 8 hours. */
export const MICROVM_MAX_SECONDS = 8 * 3600;

export function microvmImageKey(arch: string, cpu: number): string {
  return `${arch}-${cpu}cpu`;
}

export class MicrovmProvider implements Provider {
  readonly compute = 'microvm' as const;

  constructor(
    private readonly config: Config,
    private readonly images: () => Promise<ImageRegistry>,
    private readonly client = new LambdaMicrovmsClient({ region: config.region }),
  ) {}

  async launch(req: LaunchRequest): Promise<Launched> {
    const key = microvmImageKey(req.spec.arch, req.spec.cpu);
    const image = (await this.images()).microvm[key];
    if (!image) {
      throw new CapacityError(
        'microvm',
        `no MicroVM image for ${key}. Build it with: npx @mintwork/runway update --microvm-sizes ${req.spec.cpu}cpu`,
      );
    }
    try {
      const res = await this.client.send(
        new RunMicrovmCommand({
          imageIdentifier: image,
          executionRoleArn: this.config.microvm.execRoleArn,
          egressNetworkConnectors: [this.config.microvm.egressConnector],
          logging: {
            cloudWatch: { logGroup: this.config.microvm.logGroup, logStream: req.runnerName },
          },
          runHookPayload: JSON.stringify({ runnerName: req.runnerName, jitConfig: req.jitConfig }),
          maximumDurationInSeconds: Math.min(req.maxSeconds, MICROVM_MAX_SECONDS),
          clientToken: req.runnerName,
        }),
      );
      if (!res.microvmId) throw new Error('RunMicrovm returned no microvmId');
      return { resourceId: res.microvmId, detail: key };
    } catch (e) {
      if (isCapacityError(e)) throw new CapacityError('microvm', (e as Error).message);
      throw e;
    }
  }

  async terminate(resourceId: string): Promise<void> {
    try {
      await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: resourceId }));
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name !== 'ResourceNotFoundException' && name !== 'ConflictException') throw e;
    }
  }

  async listManaged(): Promise<ManagedResource[]> {
    const images = Object.values((await this.images()).microvm);
    const out: ManagedResource[] = [];
    for (const image of images) {
      let nextToken: string | undefined;
      do {
        const page = await this.client.send(
          new ListMicrovmsCommand({ imageIdentifier: image, nextToken }),
        );
        for (const vm of page.items ?? []) {
          if (
            vm.microvmId &&
            (vm.state === 'RUNNING' || vm.state === 'PENDING' || vm.state === 'SUSPENDED')
          ) {
            out.push({ resourceId: vm.microvmId, startedAt: vm.startedAt?.getTime() ?? 0 });
          }
        }
        nextToken = page.nextToken;
      } while (nextToken);
    }
    return out;
  }
}
