// `runway setup` and `runway update`: deploy the stack, create the GitHub App from this machine,
// and follow the image builds.
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
  describeStack,
  ensureBucket,
  getSecureJson,
  imagesParam,
  outputs,
  putSecureJson,
  resolveTarget,
  type Target,
  uploadHashed,
} from './aws.js';
import { createApp } from './create-app.js';
import { openBrowser, setWebhookUrl, waitForInstallation } from './github-app.js';
import { concurrentMicrovms, readMicrovmQuotas } from './quota.js';
import { bold, CliError, dim, info, mint, ok, progress, step, warn } from './ui.js';

/** Stack settings. Left out on the command line, each keeps the stack's current value (or the default). */
export interface StackSettings {
  defaultCompute: string;
  fallback: string;
  allowPublicRepos: boolean;
  maxJobMinutes: number;
  microvmSizes: string;
  runnerPolicies: string;
}

export const DEFAULT_SETTINGS: StackSettings = {
  defaultCompute: 'microvm',
  fallback: 'microvm:ec2',
  allowPublicRepos: false,
  maxJobMinutes: 360,
  microvmSizes: 'arm64-1cpu',
  runnerPolicies: '',
};

/** The stack parameter behind each setting. */
const SETTING_PARAMS: Record<keyof StackSettings, string> = {
  defaultCompute: 'DefaultCompute',
  fallback: 'Fallback',
  allowPublicRepos: 'AllowPublicRepos',
  maxJobMinutes: 'MaxJobMinutes',
  microvmSizes: 'MicrovmSizes',
  runnerPolicies: 'RunnerPolicyArns',
};

/** What was passed wins; then what the stack has now (so `update` never resets your options); then the defaults. */
export function resolveSettings(
  given: Partial<StackSettings>,
  current: Record<string, string | undefined>,
): StackSettings {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(SETTING_PARAMS) as (keyof StackSettings)[]) {
    const now = current[SETTING_PARAMS[key]];
    const value =
      given[key] ??
      (now === undefined
        ? undefined
        : key === 'allowPublicRepos'
          ? now === 'true'
          : key === 'maxJobMinutes'
            ? Number(now)
            : now);
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  if (!Number.isInteger(out.maxJobMinutes) || out.maxJobMinutes < 5 || out.maxJobMinutes > 2880)
    throw new CliError('--max-job-minutes must be a whole number from 5 to 2880');
  return out;
}

export interface DeployOptions extends Partial<StackSettings> {
  region?: string;
  stack: string;
  owner?: string;
  runnerTools?: string;
  browser: boolean;
  rebuildImages: boolean;
  wait: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function functionsZip(): Uint8Array {
  return readFileSync(new URL('./assets/functions.zip', import.meta.url));
}

async function preflight(t: Target, opts: StackSettings & { runnerTools?: string }): Promise<void> {
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

/** Create the App in your browser through a page served on 127.0.0.1 by this process. */
async function createGitHubApp(
  ssm: SSMClient,
  stack: string,
  owner: string,
  isOrg: boolean,
  webhookUrl: string,
  browser: boolean,
): Promise<StoredApp> {
  const app = await createApp({
    owner,
    isOrg,
    stack,
    webhookUrl,
    onReady: (url) => {
      step(`Create runway's GitHub App in your browser: ${url}`);
      info('The page is served by this terminal (127.0.0.1), so open it on this machine.');
      info('Then install the App on the repositories that should use runway.');
      if (browser) openBrowser(url);
    },
    save: (created) => putSecureJson(ssm, appParam(stack), created),
  }).catch((e: Error) => {
    throw new CliError(`Creating the GitHub App failed: ${e.message}. Run setup again.`);
  });
  ok(`Created the GitHub App ${bold(app.slug)} ${dim('(its key is stored in SSM)')}`);
  return app;
}

/** Follow the builds the maintainer started (recorded in the image registry). */
/** Start the image builds now (the maintainer does the work) and surface any error it hits. */
async function startBuilds(t: Target, maintainer: string): Promise<void> {
  const res = await new LambdaClient({ region: t.region }).send(
    new InvokeCommand({
      FunctionName: maintainer,
      Payload: Buffer.from(JSON.stringify({ force: true })),
    }),
  );
  // eslint-disable-next-line security-node/detect-unhandled-async-errors -- errors propagate to the caller, which reports them
  if (res.FunctionError) {
    const detail = Buffer.from(res.Payload ?? []).toString();
    throw new CliError(
      `Starting the image builds failed: ${detail.slice(0, 400)}\n    Maintainer logs: /aws/lambda/${maintainer}`,
    );
  }
}

async function waitForImages(
  t: Target,
  ssm: SSMClient,
  after: number,
  maintainer: string,
): Promise<ImageRegistry> {
  const microvms = new LambdaMicrovmsClient({ region: t.region });
  const codebuild = new CodeBuildClient({ region: t.region });
  const p = progress('Building runner images');
  const deadline = Date.now() + 75 * 60_000;
  let registry: ImageRegistry | undefined;
  const done = new Map<string, string>();
  const waitingSince = Date.now();
  let startedOurselves = false;
  while (Date.now() < deadline) {
    registry = await readRegistry(ssm, imagesParam(t.stack));
    const build = registry?.build;
    if (!registry || !build || Date.parse(build.startedAt) < after) {
      // The stack starts the first builds in the background; if nothing shows up, start them
      // here, where an error can be seen, instead of waiting forever.
      if (!startedOurselves && Date.now() - waitingSince > 2 * 60_000) {
        startedOurselves = true;
        p.update('starting the builds');
        await startBuilds(t, maintainer);
      } else p.update('starting');
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

export async function deploy(given: DeployOptions, mode: 'setup' | 'update'): Promise<void> {
  const t = await resolveTarget(given.region, given.stack);
  console.log(
    `\n  ${bold(`runway ${mode}`)} ${dim(`· account ${t.account} · ${t.region} · stack ${t.stack}`)}\n`,
  );
  const current = await describeStack(new CloudFormationClient({ region: t.region }), t.stack);
  const currentParams = Object.fromEntries(
    (current?.Parameters ?? []).map((p) => [p.ParameterKey ?? '', p.ParameterValue]),
  );
  const opts = { ...given, ...resolveSettings(given, currentParams) };
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
    app = await createGitHubApp(ssm, t.stack, owner, isOrg, out.WebhookUrl, opts.browser);
    const inst = await waitForInstallation(app, owner);
    ok(
      `Installed on ${inst.account.login} (${inst.repository_selection === 'all' ? 'all repositories' : 'selected repositories'})`,
    );
  } else {
    await setWebhookUrl(app, out.WebhookUrl);
    ok(`GitHub App ${app.slug} points at this stack`);
  }

  const registry = await readRegistry(ssm, imagesParam(t.stack));
  // The registry is written as soon as a build starts, so a recent build may still be running
  // (always the case right after the stack is created): follow it rather than calling it done.
  const recentBuild =
    registry?.build !== undefined && Date.now() - Date.parse(registry.build.startedAt) < 3600_000;
  if (!registry || rebuild || recentBuild) {
    const requested = Date.now() - 5000;
    // On first setup the stack's bootstrap already started the builds; otherwise start them here.
    if (registry && rebuild) {
      // The maintainer builds images for setup, updates and the weekly refresh alike.
      await startBuilds(t, out.MaintainerFunction);
    }
    console.log(usage(opts.defaultCompute));
    if (opts.wait) {
      info(
        'Images take about 10 minutes. Ctrl-C is safe: they keep building, and jobs wait for them.',
      );
      await waitForImages(t, ssm, registry && rebuild ? requested : 0, out.MaintainerFunction);
    } else ok('Image builds are running; follow them with "runway status"');
  } else {
    ok(
      `Runner images: actions/runner ${registry.runner.version} ${dim('(rebuilt automatically every week when a new runner ships)')}`,
    );
    console.log(usage(opts.defaultCompute));
  }
  console.log(
    `  ${mint(bold('runway is ready.'))} ${dim('Check on it any time with: npx -y @mintwork/runway status')}\n`,
  );
}
