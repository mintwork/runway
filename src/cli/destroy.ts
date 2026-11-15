// `runway destroy`: delete the stack. Its bootstrap resource removes what runway created outside
// the stack (MicroVMs and images, Lambda runner functions, SSM parameters, data), then the CLI
// removes its code bucket. The GitHub App has to be deleted on GitHub (one click).
import { createInterface } from 'node:readline/promises';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import type { StoredApp } from '../core/app-manifest.js';
import {
  appParam,
  bucketName,
  deleteStack,
  emptyAndDeleteBucket,
  getSecureJson,
  resolveTarget,
} from './aws.js';
import { bold, CliError, dim, ok } from './ui.js';

export async function destroy(opts: {
  region?: string;
  stack: string;
  yes: boolean;
}): Promise<void> {
  const t = await resolveTarget(opts.region, opts.stack);
  console.log(
    `\n  ${bold('runway destroy')} ${dim(`· account ${t.account} · ${t.region} · stack ${t.stack}`)}\n`,
  );
  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `  This deletes the runway stack "${t.stack}", its runners, images and logs. Type the stack name to confirm: `,
    );
    rl.close();
    if (answer.trim() !== t.stack) throw new CliError('Cancelled.');
  }
  const app = await getSecureJson<StoredApp>(
    new SSMClient({ region: t.region }),
    appParam(t.stack),
  );
  await deleteStack(new CloudFormationClient({ region: t.region }), t.stack);
  await emptyAndDeleteBucket(new S3Client({ region: t.region }), bucketName(t));
  ok('Deleted the stack, its runners and images, and the code bucket');

  if (app) {
    const settings = app.isOrg
      ? `https://github.com/organizations/${app.owner}/settings/apps/${app.slug}/advanced`
      : `https://github.com/settings/apps/${app.slug}/advanced`;
    console.log(
      `\n  Last step, on GitHub: delete the App ${bold(app.slug)} (Danger zone, at the bottom):`,
    );
    console.log(`  ${dim(settings)}\n`);
  }
}
