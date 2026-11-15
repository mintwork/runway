// Scheduled weekly: rebuilds the runner images when GitHub publishes a new runner release, and
// at least every 4 weeks anyway, so images pick up OS patches and the MicroVM base image never
// expires. Builds run asynchronously (MicroVM image builds, CodeBuild); this only starts them.
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { SSMClient } from '@aws-sdk/client-ssm';
import {
  latestRunner,
  readRegistry,
  registryAfterBuild,
  startImageBuilds,
  writeRegistry,
} from '../core/images.js';
import { githubHookCidrs, syncIngress } from '../core/webhook-ingress.js';
import { log } from './runtime.js';

const REBUILD_AFTER_DAYS = 28;

export async function handler(event: { force?: boolean } = {}): Promise<void> {
  const env = process.env;
  const region = env.AWS_REGION as string;
  // Keep the webhook's allowlist in step with GitHub's published ranges.
  const cidrs = await githubHookCidrs();
  if (
    await syncIngress(new APIGatewayClient({ region }), env.RUNWAY_WEBHOOK_API as string, cidrs)
  ) {
    log('updated the webhook allowlist', { ranges: cidrs.length });
  }
  const ssm = new SSMClient({ region });
  const param = env.RUNWAY_IMAGES_PARAM as string;
  const previous = await readRegistry(ssm, param);
  const runner = await latestRunner();
  const ageDays = previous ? (Date.now() - Date.parse(previous.updatedAt)) / 86_400_000 : Infinity;

  if (!event.force && previous?.runner.version === runner.version && ageDays < REBUILD_AFTER_DAYS) {
    log('images are current', { runner: runner.version, ageDays: Math.round(ageDays) });
    return;
  }
  const sizes = (env.RUNWAY_MICROVM_SIZES ?? 'arm64-1cpu')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const started = await startImageBuilds({
    stack: env.RUNWAY_STACK as string,
    region,
    bucket: env.RUNWAY_ASSETS_BUCKET as string,
    microvmSizes: sizes,
    microvmBuildRoleArn: env.RUNWAY_MICROVM_BUILD_ROLE as string,
    microvmLogGroup: env.RUNWAY_MICROVM_LOG_GROUP as string,
    codeBuildProjects: {
      arm64: env.RUNWAY_CODEBUILD_ARM64 as string,
      x64: env.RUNWAY_CODEBUILD_X64 as string,
    },
    repositoryUri: env.RUNWAY_ECR_REPOSITORY as string,
    imagesParam: param,
  });
  await writeRegistry(
    ssm,
    param,
    registryAfterBuild(previous, started, env.RUNWAY_ECR_REPOSITORY as string),
  );
  log('started image builds', {
    runner: started.runner.version,
    microvm: Object.keys(started.microvm),
    codebuild: started.codeBuildIds,
  });
}
