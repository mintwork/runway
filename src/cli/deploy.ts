// `runway setup` and `runway update`: deploy the stack, connect the GitHub App, build images.
import { readFileSync } from 'node:fs';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { BatchGetBuildsCommand, CodeBuildClient } from '@aws-sdk/client-codebuild';
import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
} from '@aws-sdk/client-lambda-microvms';
import { S3Client } from '@aws-sdk/client-s3';
import { ListServiceQuotasCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { SSMClient } from '@aws-sdk/client-ssm';
import { parseFallback } from '../core/config.js';
import {
  microvmImageState,
  readRegistry,
  registryAfterBuild,
  startImageBuilds,
  writeRegistry,
} from '../core/images.js';
import { COMPUTES } from '../core/labels.js';
import * as sources from '../generated/sources.js';
import {
  appParam,
  deployStack,
  ensureBucket,
  getSecureJson,
  imagesParam,
  outputs,
  putSecureJson,
  resolveTarget,
  type Target,
  uploadHashed,
} from './aws.js';
import {
  createApp,
  openBrowser,
  ownerType,
  type StoredApp,
  setWebhookUrl,
  waitForInstallation,
} from './github-app.js';
import { bold, CliError, dim, info, mint, ok, progress, step, warn } from './ui.js';

export interface DeployOptions {
  region?: string;
  stack: string;
  owner?: string;
  defaultCompute: string;
  fallback: string;
  allowPublicRepos: boolean;
  maxJobMinutes: number;
  microvmSizes: string;
  runnerPolicies: string;
  browser: boolean;
  rebuildImages: boolean;
  wait: boolean;
}

function functionsZip(): Uint8Array {
  return readFileSync(new URL('./assets/functions.zip', import.meta.url));
}

async function preflight(t: Target, opts: DeployOptions): Promise<void> {
  if (!COMPUTES.includes(opts.defaultCompute as never))
    throw new CliError(`--default-compute must be one of ${COMPUTES.join(', ')}`);
  parseFallback(opts.fallback);
  for (const size of opts.microvmSizes.split(',').filter(Boolean)) {
    if (!/^(arm64|x64)-(1|2|4)cpu$/.test(size))
      throw new CliError(
        `bad --microvm-sizes entry "${size}": use arm64-1cpu, arm64-2cpu or arm64-4cpu`,
      );
  }
  const microvms = new LambdaMicrovmsClient({ region: t.region });
  try {
    await microvms.send(new ListManagedMicrovmImagesCommand({}));
  } catch {
    warn(
      `Lambda MicroVMs aren't available in ${t.region}; microvm jobs will use the fallback (${opts.fallback || 'none'}).`,
    );
    return;
  }
  try {
    const quotas = await new ServiceQuotasClient({ region: t.region }).send(
      new ListServiceQuotasCommand({ ServiceCode: 'lambda', MaxResults: 100 }),
    );
    const mem = quotas.Quotas?.find((q) => q.QuotaName === 'Max allocated ARM_64 MicroVM memory');
    if (mem?.Value !== undefined) {
      const smallest = Math.min(
        ...opts.microvmSizes
          .split(',')
          .filter(Boolean)
          .map((s) => Number(s.match(/(\d)cpu/)?.[1] ?? 1) * 2048),
      );
      const concurrent = Math.floor(mem.Value / smallest);
      if (concurrent < 4) {
        warn(
          `Your MicroVM memory quota is ${mem.Value} MiB: ${concurrent} MicroVM job${concurrent === 1 ? '' : 's'} at a time. More queue (or use the fallback).`,
        );
        info(
          `Raise "Max allocated ARM_64 MicroVM memory" in Service Quotas (${t.region}) to run more at once.`,
        );
      }
    }
  } catch {
    // Quotas are advisory; never block setup on them.
  }
}

async function waitForImages(
  t: Target,
  started: Awaited<ReturnType<typeof startImageBuilds>>,
): Promise<void> {
  const microvms = new LambdaMicrovmsClient({ region: t.region });
  const codebuild = new CodeBuildClient({ region: t.region });
  const p = progress('Building runner images');
  const done = new Map<string, string>();
  const deadline = Date.now() + 60 * 60_000;
  while (Date.now() < deadline) {
    for (const [key, arn] of Object.entries(started.microvm)) {
      if (done.has(`microvm ${key}`)) continue;
      const s = await microvmImageState(microvms, arn);
      if (s.state === 'CREATE_FAILED' || s.state === 'UPDATE_FAILED')
        done.set(`microvm ${key}`, 'failed');
      else if ((s.state === 'CREATED' || s.state === 'UPDATED') && s.active)
        done.set(`microvm ${key}`, 'ok');
    }
    const builds = await codebuild.send(new BatchGetBuildsCommand({ ids: started.codeBuildIds }));
    for (const b of builds.builds ?? []) {
      const label = `container ${b.projectName?.split('-').pop()}`;
      if (b.buildStatus && b.buildStatus !== 'IN_PROGRESS')
        done.set(label, b.buildStatus === 'SUCCEEDED' ? 'ok' : `failed: ${b.buildStatus}`);
    }
    const total = Object.keys(started.microvm).length + started.codeBuildIds.length;
    p.update(`${done.size}/${total} done`);
    if (done.size === total) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  const failed = [...done].filter(([, v]) => v !== 'ok');
  if (failed.length || done.size === 0) {
    p.done('Runner images', false);
    throw new CliError(
      `Some images didn't build: ${failed.map(([k, v]) => `${k} (${v})`).join(', ') || 'timed out'}.\n    Build logs: CloudWatch log groups /runway/${t.stack}/microvm and /runway/${t.stack}/codebuild.`,
    );
  }
  p.done(
    `Runner images built (actions/runner ${started.runner.version}: ${[...done.keys()].join(', ')})`,
  );
}

export async function deploy(opts: DeployOptions, mode: 'setup' | 'update'): Promise<void> {
  const t = await resolveTarget(opts.region, opts.stack);
  console.log(
    `\n  ${bold(`runway ${mode}`)} ${dim(`· account ${t.account} · ${t.region} · stack ${t.stack}`)}\n`,
  );
  await preflight(t, opts);

  const ssm = new SSMClient({ region: t.region });
  const s3 = new S3Client({ region: t.region });
  let app = await getSecureJson<StoredApp>(ssm, appParam(t.stack));
  const owner = opts.owner ?? app?.owner;
  if (!owner)
    throw new CliError(
      'Pass --owner: the GitHub organization or user whose repositories will use runway.',
    );
  const isOrg = (await ownerType(owner)) === 'Organization';
  ok(`GitHub ${isOrg ? 'organization' : 'user'} ${owner}`);

  const bucket = await ensureBucket(s3, t);
  const functionsKey = await uploadHashed(s3, bucket, 'runway/functions', '.zip', functionsZip());
  const agentKey = await uploadHashed(
    s3,
    bucket,
    'runway/agent/runway_agent',
    '.py',
    sources.agent,
  );
  const templateKey = await uploadHashed(s3, bucket, 'runway/template', '.yaml', sources.template);
  ok(`Uploaded code to s3://${bucket}`);

  const cf = new CloudFormationClient({ region: t.region });
  const stack = await deployStack(
    cf,
    t.stack,
    `https://${bucket}.s3.${t.region}.amazonaws.com/${templateKey}`,
    {
      AssetsBucket: bucket,
      FunctionsKey: functionsKey,
      AgentKey: agentKey,
      AllowedOwners: owner,
      AllowPublicRepos: String(opts.allowPublicRepos),
      DefaultCompute: opts.defaultCompute,
      Fallback: opts.fallback,
      MaxJobMinutes: String(opts.maxJobMinutes),
      MicrovmSizes: opts.microvmSizes,
      RunnerPolicyArns: opts.runnerPolicies,
    },
  );
  const out = outputs(stack);
  ok(`Stack ${t.stack} is ready`);

  if (!app) {
    app = await createApp({
      owner,
      isOrg,
      webhookUrl: out.WebhookUrl,
      stack: t.stack,
      browser: opts.browser,
    });
    await putSecureJson(ssm, appParam(t.stack), app);
    ok(`Created the GitHub App ${bold(app.slug)} ${dim(app.htmlUrl)}`);
    const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
    step(`Install it on the repositories that should use runway: ${installUrl}`);
    if (opts.browser) openBrowser(installUrl);
    const inst = await waitForInstallation(app, owner);
    ok(
      `Installed on ${inst.account.login} (${inst.repository_selection === 'all' ? 'all repositories' : 'selected repositories'})`,
    );
  } else {
    await setWebhookUrl(app, out.WebhookUrl);
    ok(`GitHub App ${app.slug} points at this stack`);
  }

  const registry = await readRegistry(ssm, imagesParam(t.stack));
  if (!registry || opts.rebuildImages) {
    const started = await startImageBuilds({
      stack: t.stack,
      region: t.region,
      bucket,
      microvmSizes: opts.microvmSizes.split(',').filter(Boolean),
      microvmBuildRoleArn: out.MicrovmBuildRoleArn,
      microvmLogGroup: out.MicrovmLogGroup,
      codeBuildProjects: { arm64: out.CodeBuildArm64, x64: out.CodeBuildX64 },
      repositoryUri: out.RepositoryUri,
      imagesParam: imagesParam(t.stack),
    });
    await writeRegistry(
      ssm,
      imagesParam(t.stack),
      registryAfterBuild(registry, started, out.RepositoryUri),
    );
    if (opts.wait) await waitForImages(t, started);
    else
      ok(
        `Started image builds (actions/runner ${started.runner.version}); check with "runway status"`,
      );
  } else {
    ok(
      `Runner images: actions/runner ${registry.runner.version} ${dim('(rebuilt automatically every week when a new runner ships)')}`,
    );
  }

  console.log(`
  ${mint(bold('runway is ready.'))} Pick the machine per job with runs-on:

    ${bold('runs-on: [runway]')}                         ${dim(`${opts.defaultCompute}, default size`)}
    ${bold('runs-on: [runway, microvm, 2cpu]')}          ${dim('Lambda MicroVM, Docker included')}
    ${bold('runs-on: [runway, ec2, spot, 8cpu]')}        ${dim('EC2 Spot, falls back to on-demand')}
    ${bold('runs-on: [runway, fargate, x64, 4cpu]')}     ${dim('ECS Fargate task')}
    ${bold('runs-on: [runway, lambda]')}                 ${dim('Lambda function, jobs up to 15 minutes')}

  ${dim('Check on it any time with: npx @mintwork/runway status')}
`);
}
