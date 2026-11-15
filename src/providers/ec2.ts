// EC2: one instance per job, on-demand or Spot, any instance type. The user-data script
// installs Docker and the runner on Amazon Linux 2023, runs the agent for one job, and
// shuts down; InstanceInitiatedShutdownBehavior=terminate turns that into termination.
import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  type RunInstancesCommandInput,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import type { Config, ImageRegistry } from '../core/config.js';
import {
  CapacityError,
  isCapacityError,
  type Launched,
  type LaunchRequest,
  type ManagedResource,
  type Provider,
} from './types.js';

const AMI = {
  arm64: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
  x64: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
};

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface UserDataInput {
  runnerName: string;
  jitConfig: string;
  arch: 'arm64' | 'x64';
  runnerVersion: string;
  runnerSha256: string;
  agentS3Uri: string;
  runnerToolsS3Uri?: string;
  maxMinutes: number;
}

export function userData(i: UserDataInput): string {
  const asset = `actions-runner-linux-${i.arch}-${i.runnerVersion}.tar.gz`;
  return `#!/bin/bash
# runway: one GitHub Actions job, then shut down (and so terminate).
set -euo pipefail
exec > >(tee -a /var/log/runway.log > /dev/console) 2>&1
trap 'echo "runway: shutting down"; shutdown -h now' EXIT
shutdown -h +${i.maxMinutes} "runway: job time limit reached" || true

dnf install -y --setopt=install_weak_deps=0 docker git libicu tar gzip jq unzip python3 >/dev/null
systemctl enable --now docker
id runner >/dev/null 2>&1 || useradd --create-home --groups docker runner
echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner

mkdir -p /opt/actions-runner
cd /opt/actions-runner
curl -fsSL --retry 3 -o runner.tgz https://github.com/actions/runner/releases/download/v${i.runnerVersion}/${asset}
echo "${i.runnerSha256}  runner.tgz" | sha256sum -c -
tar xzf runner.tgz && rm runner.tgz
chown -R runner:runner /opt/actions-runner

aws s3 cp --only-show-errors ${shellQuote(i.agentS3Uri)} /opt/runway_agent.py
${
  i.runnerToolsS3Uri
    ? `# Your runner-tools.sh, if you set one (runway update --runner-tools <file>).
if aws s3 cp --only-show-errors ${shellQuote(i.runnerToolsS3Uri)} /opt/runner-tools.sh 2>/dev/null; then
  RUNWAY_ARCH=${i.arch} RUNWAY_TARGET=ec2 bash -euo pipefail /opt/runner-tools.sh
fi`
    : ''
}
RUNWAY_RUNNER_NAME=${shellQuote(i.runnerName)} RUNWAY_JIT_CONFIG=${shellQuote(i.jitConfig)} \\
  RUNWAY_RUNNER_DIR=/opt/actions-runner RUNWAY_RUN_AS=runner \\
  python3 /opt/runway_agent.py oneshot
`;
}

export class Ec2Provider implements Provider {
  readonly compute = 'ec2' as const;

  constructor(
    private readonly config: Config,
    private readonly images: () => Promise<ImageRegistry>,
    private readonly client = new EC2Client({ region: config.region }),
  ) {}

  async launch(req: LaunchRequest): Promise<Launched> {
    const { spec } = req;
    const registry = await this.images();
    const script = userData({
      runnerName: req.runnerName,
      jitConfig: req.jitConfig,
      arch: spec.arch,
      runnerVersion: registry.runner.version,
      runnerSha256: registry.runner.sha256[spec.arch],
      agentS3Uri: this.config.ec2.agentS3Uri,
      runnerToolsS3Uri: this.config.ec2.runnerToolsS3Uri,
      maxMinutes: Math.ceil(req.maxSeconds / 60),
    });
    const markets: ('spot' | 'on-demand')[] = spec.spot ? ['spot', 'on-demand'] : ['on-demand'];
    const subnets = shuffle(this.config.subnets);
    const errors: string[] = [];

    for (const market of markets) {
      for (const instanceType of spec.instanceTypes ?? []) {
        for (const subnet of subnets) {
          const input: RunInstancesCommandInput = {
            ImageId: AMI[spec.arch],
            InstanceType: instanceType as RunInstancesCommandInput['InstanceType'],
            MinCount: 1,
            MaxCount: 1,
            UserData: Buffer.from(script).toString('base64'),
            IamInstanceProfile: { Arn: this.config.ec2.instanceProfileArn },
            InstanceInitiatedShutdownBehavior: 'terminate',
            NetworkInterfaces: [
              {
                DeviceIndex: 0,
                SubnetId: subnet,
                Groups: [this.config.securityGroup],
                AssociatePublicIpAddress: true,
              },
            ],
            MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
            BlockDeviceMappings: [
              {
                DeviceName: '/dev/xvda',
                Ebs: {
                  VolumeSize: spec.diskGb ?? 30,
                  VolumeType: 'gp3',
                  Encrypted: true,
                  DeleteOnTermination: true,
                },
              },
            ],
            TagSpecifications: ['instance', 'volume'].map((ResourceType) => ({
              ResourceType: ResourceType as 'instance',
              Tags: [
                { Key: 'Name', Value: req.runnerName },
                { Key: 'runway:stack', Value: this.config.stack },
                { Key: 'runway:runner', Value: req.runnerName },
              ],
            })),
            ...(market === 'spot'
              ? {
                  InstanceMarketOptions: {
                    MarketType: 'spot',
                    SpotOptions: {
                      SpotInstanceType: 'one-time',
                      InstanceInterruptionBehavior: 'terminate',
                    },
                  },
                }
              : {}),
          };
          try {
            const res = await this.client.send(new RunInstancesCommand(input));
            const id = res.Instances?.[0]?.InstanceId;
            if (!id) throw new Error('RunInstances returned no instance');
            return { resourceId: id, detail: `${instanceType} ${market}` };
          } catch (e) {
            if (!isCapacityError(e)) throw e;
            errors.push(`${instanceType}/${market}/${subnet}: ${(e as Error).name}`);
          }
        }
      }
    }
    throw new CapacityError('ec2', `no capacity: ${errors.slice(0, 6).join('; ')}`);
  }

  async terminate(resourceId: string): Promise<void> {
    try {
      await this.client.send(new TerminateInstancesCommand({ InstanceIds: [resourceId] }));
    } catch (e) {
      if ((e as { name?: string }).name !== 'InvalidInstanceID.NotFound') throw e;
    }
  }

  async listManaged(): Promise<ManagedResource[]> {
    const out: ManagedResource[] = [];
    let NextToken: string | undefined;
    do {
      const page = await this.client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: 'tag:runway:stack', Values: [this.config.stack] },
            { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
          ],
          NextToken,
        }),
      );
      for (const r of page.Reservations ?? []) {
        for (const i of r.Instances ?? []) {
          if (i.InstanceId)
            out.push({ resourceId: i.InstanceId, startedAt: i.LaunchTime?.getTime() ?? 0 });
        }
      }
      NextToken = page.NextToken;
    } while (NextToken);
    return out;
  }
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
