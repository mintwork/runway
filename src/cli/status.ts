// `runway status`: is everything connected, what are the images, and what ran recently.
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { StoredApp } from '../core/app-manifest.js';
import { microvmImageState, readRegistry } from '../core/images.js';
import type { Refusal, RunnerRecord } from '../core/state.js';
import {
  appParam,
  describeStack,
  getSecureJson,
  imagesParam,
  outputs,
  resolveTarget,
} from './aws.js';
import { installations } from './github-app.js';
import { concurrentMicrovms, readMicrovmQuotas } from './quota.js';
import { bold, CliError, dim, fail, green, ok, red, warn, yellow } from './ui.js';

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 60
    ? `${m}m ago`
    : m < 2880
      ? `${Math.round(m / 60)}h ago`
      : `${Math.round(m / 1440)}d ago`;
};

export async function status(opts: {
  region?: string;
  stack: string;
  limit: number;
}): Promise<void> {
  const t = await resolveTarget(opts.region, opts.stack);
  console.log(
    `\n  ${bold('runway status')} ${dim(`· account ${t.account} · ${t.region} · stack ${t.stack}`)}\n`,
  );

  const stack = await describeStack(new CloudFormationClient({ region: t.region }), t.stack);
  if (!stack)
    throw new CliError(
      `No runway stack "${t.stack}" in ${t.region}. Set it up with: npx @mintwork/runway setup --owner <org>`,
    );
  const out = outputs(stack);
  const good = /^(CREATE|UPDATE)_COMPLETE$/.test(stack.StackStatus ?? '');
  (good ? ok : fail)(`Stack ${stack.StackStatus?.toLowerCase().replaceAll('_', ' ')}`);

  const ssm = new SSMClient({ region: t.region });
  const app = await getSecureJson<StoredApp>(ssm, appParam(t.stack));
  if (!app) fail(`No GitHub App yet. Finish setup here: ${out.SetupUrl}`);
  else {
    try {
      const inst = await installations(app);
      if (inst.length === 0)
        warn(
          `GitHub App ${app.slug} isn't installed anywhere: https://github.com/apps/${app.slug}/installations/new`,
        );
      else
        ok(
          `GitHub App ${app.slug} installed on ${inst.map((i) => `${i.account.login} (${i.repository_selection})`).join(', ')}`,
        );
    } catch (e) {
      fail(`GitHub App ${app.slug}: ${(e as Error).message}`);
    }
  }

  const registry = await readRegistry(ssm, imagesParam(t.stack));
  if (!registry)
    warn('Runner images are still building (about 10 minutes after the stack is created).');
  else {
    ok(
      `Runner images: actions/runner ${registry.runner.version}, built ${ago(Date.parse(registry.updatedAt))}`,
    );
    const microvms = new LambdaMicrovmsClient({ region: t.region });
    for (const [key, arn] of Object.entries(registry.microvm)) {
      const s = await microvmImageState(microvms, arn).catch((e: Error) => ({
        state: `error: ${e.message}`,
        active: undefined,
        failed: undefined,
      }));
      const line = `MicroVM image ${key}: ${String(s.state).toLowerCase()}${s.active ? `, version ${s.active} active` : ''}${s.failed ? `, version ${s.failed} failed` : ''}`;
      (s.active ? ok : warn)(line);
    }
  }

  try {
    for (const q of await readMicrovmQuotas(t.region)) {
      console.log(
        `  ${dim('·')} ${q.arch} MicroVM memory quota: ${q.gb} GB ${dim(`(${concurrentMicrovms(q.gb, 1)} x 1cpu MicroVMs at once)`)}`,
      );
    }
  } catch {
    // advisory only
  }

  const dlq = await new SQSClient({ region: t.region })
    .send(
      new GetQueueAttributesCommand({
        QueueUrl: out.DeadLetterQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    )
    .catch(() => undefined);
  const dead = Number(dlq?.Attributes?.ApproximateNumberOfMessages ?? 0);
  if (dead > 0)
    warn(
      `${dead} event(s) failed repeatedly and are in the dead-letter queue. Worker logs: /aws/lambda/runway-${t.stack}-worker`,
    );

  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: t.region }));
  const items: RunnerRecord[] = [];
  const refusals: Refusal[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: out.TableName,
        FilterExpression: 'begins_with(pk, :p) OR begins_with(pk, :r)',
        ExpressionAttributeValues: { ':p': 'runway-', ':r': 'refused#' },
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (String(item.pk).startsWith('refused#')) refusals.push(item as Refusal);
      else items.push(item as RunnerRecord);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  items.sort((a, b) => b.launchedAt - a.launchedAt);

  console.log(
    `\n  ${bold('Recent runners')}${items.length ? '' : dim('  none yet: add runs-on: [runway] to a workflow job')}`,
  );
  const paint = {
    busy: yellow,
    launched: yellow,
    launching: yellow,
    done: green,
    failed: red,
  } as const;
  for (const r of items.slice(0, opts.limit)) {
    const state = (paint[r.state] ?? ((s: string) => s))(r.state.padEnd(9));
    console.log(
      `  ${state} ${r.pk}  ${r.compute.padEnd(7)} ${dim((r.detail ?? '').padEnd(22))} ${r.owner}/${r.repo} job ${r.jobId}  ${dim(ago(r.launchedAt))}`,
    );
    if (r.error && r.state !== 'done') console.log(`            ${red(r.error.slice(0, 160))}`);
  }
  if (refusals.length) {
    refusals.sort((a, b) => b.at - a.at);
    console.log(
      `\n  ${bold('Refused jobs')} ${dim('(they wait in GitHub until cancelled or changed)')}`,
    );
    for (const r of refusals.slice(0, opts.limit)) {
      console.log(
        `  ${red('refused')}  ${r.owner}/${r.repo} job ${r.jobId}  ${dim(`[${r.labels.join(', ')}]`)}  ${dim(ago(r.at))}`,
      );
      console.log(`           ${r.reason}`);
    }
  }
  console.log('');
}
