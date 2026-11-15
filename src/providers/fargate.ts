// ECS Fargate: one task per job from our runner container image. The task's CPU, memory and
// ephemeral storage are set per job with RunTask overrides, so one task definition per
// architecture covers every size. The container runs the agent in oneshot mode and exits.

import type { ECRClient } from '@aws-sdk/client-ecr';
import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import type { Config } from '../core/config.js';
import { containerImageReady, defaultEcr } from './readiness.js';
import {
  CapacityError,
  isCapacityError,
  type Launched,
  type LaunchRequest,
  type ManagedResource,
  NotReadyError,
  type Provider,
} from './types.js';

export const CONTAINER_NAME = 'runner';
const STARTED_BY = 'runway';

export class FargateProvider implements Provider {
  readonly compute = 'fargate' as const;

  constructor(
    private readonly config: Config,
    private readonly client = new ECSClient({ region: config.region }),
    private readonly ecr: ECRClient = defaultEcr(config.region),
  ) {}

  async launch(req: LaunchRequest): Promise<Launched> {
    const { spec } = req;
    if (
      !(await containerImageReady(
        this.ecr,
        this.config.lambda.repositoryUri,
        `fargate-${spec.arch}`,
      ))
    ) {
      throw new NotReadyError(
        'fargate',
        `the ${spec.arch} Fargate runner image is still being built`,
      );
    }
    const taskDefinition =
      spec.arch === 'arm64' ? this.config.fargate.taskDefArm64 : this.config.fargate.taskDefX64;
    try {
      const res = await this.client.send(
        new RunTaskCommand({
          cluster: this.config.fargate.cluster,
          taskDefinition,
          launchType: 'FARGATE',
          platformVersion: 'LATEST',
          count: 1,
          startedBy: STARTED_BY,
          clientToken: req.runnerName,
          propagateTags: 'TASK_DEFINITION',
          tags: [
            { key: 'runway:stack', value: this.config.stack },
            { key: 'runway:runner', value: req.runnerName },
          ],
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: this.config.subnets,
              securityGroups: [this.config.securityGroup],
              assignPublicIp: 'ENABLED',
            },
          },
          overrides: {
            cpu: String(spec.cpu * 1024),
            memory: String(spec.memoryGb * 1024),
            ...(spec.diskGb ? { ephemeralStorage: { sizeInGiB: spec.diskGb } } : {}),
            containerOverrides: [
              {
                name: CONTAINER_NAME,
                environment: [
                  { name: 'RUNWAY_RUNNER_NAME', value: req.runnerName },
                  { name: 'RUNWAY_JIT_CONFIG', value: req.jitConfig },
                  { name: 'RUNWAY_MAX_SECONDS', value: String(req.maxSeconds) },
                ],
              },
            ],
          },
        }),
      );
      const task = res.tasks?.[0]?.taskArn;
      if (task)
        return { resourceId: task, detail: `${spec.arch} ${spec.cpu}cpu/${spec.memoryGb}gb` };
      const reasons = (res.failures ?? [])
        .map((f) => `${f.reason}${f.detail ? ` (${f.detail})` : ''}`)
        .join('; ');
      throw new CapacityError('fargate', reasons || 'RunTask started no task');
    } catch (e) {
      if (e instanceof CapacityError) throw e;
      if (isCapacityError(e)) throw new CapacityError('fargate', (e as Error).message);
      throw e;
    }
  }

  async terminate(resourceId: string): Promise<void> {
    try {
      await this.client.send(
        new StopTaskCommand({
          cluster: this.config.fargate.cluster,
          task: resourceId,
          reason: 'runway: job finished',
        }),
      );
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name !== 'InvalidParameterException' && name !== 'ResourceNotFoundException') throw e;
    }
  }

  async listManaged(): Promise<ManagedResource[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListTasksCommand({
          cluster: this.config.fargate.cluster,
          startedBy: STARTED_BY,
          desiredStatus: 'RUNNING',
          nextToken,
        }),
      );
      arns.push(...(page.taskArns ?? []));
      nextToken = page.nextToken;
    } while (nextToken);
    const out: ManagedResource[] = [];
    for (let i = 0; i < arns.length; i += 100) {
      const res = await this.client.send(
        new DescribeTasksCommand({
          cluster: this.config.fargate.cluster,
          tasks: arns.slice(i, i + 100),
        }),
      );
      for (const t of res.tasks ?? []) {
        if (t.taskArn)
          out.push({
            resourceId: t.taskArn,
            startedAt: (t.startedAt ?? t.createdAt)?.getTime() ?? 0,
          });
      }
    }
    return out;
  }
}
