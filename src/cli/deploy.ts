// `runway setup` and `runway update`: deploy the stack, finish setup through the stack's own
// setup page, and follow the image builds.
import { readFileSync } from 'node:fs';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { BatchGetBuildsCommand, CodeBuildClient } from '@aws-sdk/client-codebuild';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
} from '@aws-sdk/client-lambda-microvms';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { ownerIsOrg, type StoredApp } from '../core/app-manifest.js';
import { type ImageRegistry, parseFallback } from '../core/config.js';
import { microvmImageState, RUNNER_TOOLS_KEY, readRegistry } from '../core/images.js';
import { COMPUTES } from '../core/labels.js';
import { githubHookCidrs, syncIngress } from '../core/webhook-ingress.js';
import * as sources from '../generated/sources.js';
import {
  appParam,
  deployStack,
  ensureBucket,
  getSecureJson,
  imagesParam,
  outputs,
  resolveTarget,
  type Target,
  uploadHashed,
} from './aws.js';
import { openBrowser, setWebhookUrl, waitForInstallation } from './github-app.js';
import { concurrentMicrovms, readMicrovmQuotas } from './quota.js';
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
  runnerTools?: string;
  browser: boolean;
  rebuildImages: boolean;
  wait: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function functionsZip(): Uint8Array {
  return readFileSync(new URL('./assets/functions.zip', import.meta.url));
}

async function preflight(t: Target, opts: DeployOptions): Promise<void> {
  if (!COMPUTES.includes(opts.defaultCompute as never))
    throw new CliError(`--default-compute must be one of ${COMPUTES.join(', ')}`);
  parseFallback(opts.fallback);
  for (const size of opts.microvmSizes.split(',').filter(Boolean)) {
    if (!/^(arm64|x64)-(1|2|4)cpu$/.test(size)) {
      throw new CliError(
        `bad --microvm-sizes entry "${size}": use arm64-1cpu, arm64-2cpu, arm64-4cpu (or x64-…)`,
      );
    }
  }
  if (opts.runnerTools && opts.runnerTools !== 'none') {
    try {
      readFileSync(opts.runnerTools);
    } catch {
      throw new CliError(`--runner-tools: can't read ${opts.runnerTools}`);
    }
  }
  try {
    await new LambdaMicrovmsClient({ region: t.region }).send(
      new ListManagedMicrovmImagesCommand({}),
    );
  } catch {
    warn(
      `Lambda MicroVMs aren't available in ${t.region}; microvm jobs will use the fallback (${opts.fallback || 'none'}).`,
    );
    return;
  }
  try {
    for (const q of await readMicrovmQuotas(t.region)) {
      const sizes = opts.microvmSizes.split(',').filter((k) => k.startsWith(q.arch));
      if (sizes.length === 0) continue;
      const cpu = Math.min(...sizes.map((k) => Number(k.match(/(\d)cpu/)?.[1] ?? 1)));
      const concurrent = concurrentMicrovms(q.gb, cpu);
      if (concurrent < 10) {
        warn(
          `Your ${q.arch} MicroVM memory quota is ${q.gb} GB: ${concurrent} ${cpu}cpu MicroVM job${concurrent === 1 ? '' : 's'} at a time.`,
        );
        info(
          `Raise "Max allocated ${q.arch === 'arm64' ? 'ARM_64' : 'X86_64'} MicroVM memory" in Service Quotas (${t.region}) to run more at once.`,
        );
      }
    }
  } catch {
    // Quotas are advisory; never block setup on them.
  }
}

/** Wait for the App: you create it on the stack's setup page, which stores it in SSM. */
async function waitForApp(
  ssm: SSMClient,
  stack: string,
  setupUrl: string,
  browser: boolean,
): Promise<StoredApp> {
  step(`Finish setup in your browser: ${setupUrl}`);
  info('Create the GitHub App there, then install it on the repositories that should use runway.');
  info('(Works from any browser: copy the link if this machine has none.)');
  if (browser) openBrowser(setupUrl);
  const p = progress('Waiting for the GitHub App');
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const app = await getSecureJson<StoredApp>(ssm, appParam(stack));
    if (app) {
      p.done(`Created the GitHub App ${bold(app.slug)}`);
      return app;
    }
    p.update('not created yet');
    await sleep(3000);
  }
  p.done('GitHub App', false);
  throw new CliError(
    `The App wasn't created within 30 minutes. Open ${setupUrl} and run "runway status" afterwards.`,
  );
}

/** Follow the builds the maintainer started (recorded in the image registry). */
async function waitForImages(t: Target, ssm: SSMClient, after: number): Promise<ImageRegistry> {
  const microvms = new LambdaMicrovmsClient({ region: t.region });
  const codebuild = new CodeBuildClient({ region: t.region });
  const p = progress('Building runner images');
  const deadline = Date.now() + 75 * 60_000;
  let registry: ImageRegistry | undefined;
  const done = new Map<string, string>();
  while (Date.now() < deadline) {
    registry = await readRegistry(ssm, imagesParam(t.stack));
    const build = registry?.build;
    if (!registry || !build || Date.parse(build.startedAt) < after) {
      p.update('starting');
      await sleep(5000);
      continue;
    }
    for (const [key, arn] of Object.entries(registry.microvm)) {
      if (done.has(`microvm ${key}`)) continue;
      const s = await microvmImageState(microvms, arn);
      const previous = build.previousMicrovmVersions[key];
      if (s.failed && s.failed !== previous && (!s.active || s.active === previous))
        done.set(`microvm ${key}`, `failed (version ${s.failed})`);
      else if (
        s.active &&
        s.active !== previous &&
        (s.state === 'CREATED' || s.state === 'UPDATED')
      )
        done.set(`microvm ${key}`, 'ok');
    }
    if (build.codeBuildIds.length) {
      const builds = await codebuild.send(new BatchGetBuildsCommand({ ids: build.codeBuildIds }));
      for (const b of builds.builds ?? []) {
        const label = `container ${b.projectName?.split('-').pop()}`;
        if (b.buildStatus && b.buildStatus !== 'IN_PROGRESS')
          done.set(label, b.buildStatus === 'SUCCEEDED' ? 'ok' : `failed: ${b.buildStatus}`);
      }
    }
    const total = Object.keys(registry.microvm).length + build.codeBuildIds.length;
    p.update(`${done.size}/${total} done`);
    if (total > 0 && done.size === total) break;
    await sleep(10_000);
  }
  const failed = [...done].filter(([, v]) => v !== 'ok');
  if (!registry || failed.length || done.size === 0) {
    p.done('Runner images', false);
    throw new CliError(
      `Some images didn't build: ${failed.map(([k, v]) => `${k} (${v})`).join(', ') || 'timed out'}.\n    Build logs: CloudWatch log groups /runway/${t.stack}/microvm and /runway/${t.stack}/codebuild.`,
    );
  }
  p.done(
    `Runner images built (actions/runner ${registry.runner.version}: ${[...done.keys()].join(', ')})`,
  );
  return registry;
}

const usage = (defaultCompute: string) => `
  Pick the machine per job with runs-on:

    ${bold('runs-on: [runway]')}                         ${dim(`${defaultCompute}, default size`)}
    ${bold('runs-on: [runway, microvm, 2cpu]')}          ${dim('Lambda MicroVM, Docker included')}
    ${bold('runs-on: [runway, ec2, spot, 8cpu]')}        ${dim('EC2 Spot, falls back to on-demand')}
    ${bold('runs-on: [runway, fargate, x64, 4cpu]')}     ${dim('ECS Fargate task')}
    ${bold('runs-on: [runway, lambda]')}                 ${dim('Lambda function, jobs up to 15 minutes')}
`;

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
  const isOrg = await ownerIsOrg(owner).catch((e: Error) => {
    throw new CliError(e.message);
  });
  ok(`GitHub ${isOrg ? 'organization' : 'user'} ${owner}`);

  const codeBucket = await ensureBucket(s3, t);
  const functionsKey = await uploadHashed(
    s3,
    codeBucket,
    'runway/functions',
    '.zip',
    functionsZip(),
  );
  const templateKey = await uploadHashed(
    s3,
    codeBucket,
    'runway/template',
    '.yaml',
    sources.template,
  );
  ok(`Uploaded code to s3://${codeBucket}`);

  const hookCidrs = await githubHookCidrs();
  const stack = await deployStack(
    new CloudFormationClient({ region: t.region }),
    t.stack,
    `https://${codeBucket}.s3.${t.region}.amazonaws.com/${templateKey}`,
    {
      GitHubOwner: owner,
      CodeBucket: codeBucket,
      FunctionsKey: functionsKey,
      AllowPublicRepos: String(opts.allowPublicRepos),
      DefaultCompute: opts.defaultCompute,
      Fallback: opts.fallback,
      MaxJobMinutes: String(opts.maxJobMinutes),
      MicrovmSizes: opts.microvmSizes,
      RunnerPolicyArns: opts.runnerPolicies,
      GitHubHookCidrs: hookCidrs.join(','),
    },
  );
  const out = outputs(stack);
  // CloudFormation doesn't redeploy a REST API when only its policy changes; do it here.
  await syncIngress(new APIGatewayClient({ region: t.region }), out.WebhookApiId, hookCidrs, true);
  ok(
    `Stack ${t.stack} is ready ${dim(`(webhook accepts GitHub's ${hookCidrs.length} webhook ranges only)`)}`,
  );

  let rebuild = opts.rebuildImages;
  if (opts.runnerTools) {
    if (opts.runnerTools === 'none') {
      await s3.send(new DeleteObjectCommand({ Bucket: out.DataBucket, Key: RUNNER_TOOLS_KEY }));
      ok('Removed runner-tools.sh');
    } else {
      await s3.send(
        new PutObjectCommand({
          Bucket: out.DataBucket,
          Key: RUNNER_TOOLS_KEY,
          Body: readFileSync(opts.runnerTools),
        }),
      );
      ok(
        `Uploaded ${opts.runnerTools} as runner-tools.sh ${dim('(baked into images; EC2 runs it at boot)')}`,
      );
    }
    rebuild = true;
  }

  if (!app) {
    app = await waitForApp(ssm, t.stack, out.SetupUrl, opts.browser);
    const inst = await waitForInstallation(app, owner);
    ok(
      `Installed on ${inst.account.login} (${inst.repository_selection === 'all' ? 'all repositories' : 'selected repositories'})`,
    );
  } else {
    await setWebhookUrl(app, out.WebhookUrl);
    ok(`GitHub App ${app.slug} points at this stack`);
  }

  const registry = await readRegistry(ssm, imagesParam(t.stack));
  if (!registry || rebuild) {
    const requested = Date.now() - 5000;
    // On first setup the stack's bootstrap already started the builds; otherwise start them here.
    if (registry) {
      // The maintainer builds images for setup, updates and the weekly refresh alike.
      const res = await new LambdaClient({ region: t.region }).send(
        new InvokeCommand({
          FunctionName: out.MaintainerFunction,
          Payload: Buffer.from(JSON.stringify({ force: true })),
        }),
      );
      if (res.FunctionError)
        throw new CliError(
          `Starting the image builds failed: ${Buffer.from(res.Payload ?? []).toString()}`,
        );
    }
    console.log(usage(opts.defaultCompute));
    if (opts.wait) {
      info(
        'Images take about 10 minutes. Ctrl-C is safe: they keep building, and jobs wait for them.',
      );
      await waitForImages(t, ssm, registry ? requested : 0);
    } else ok('Image builds are running; follow them with "runway status"');
  } else {
    ok(
      `Runner images: actions/runner ${registry.runner.version} ${dim('(rebuilt automatically every week when a new runner ships)')}`,
    );
    console.log(usage(opts.defaultCompute));
  }
  console.log(
    `  ${mint(bold('runway is ready.'))} ${dim('Check on it any time with: npx @mintwork/runway status')}\n`,
  );
}
