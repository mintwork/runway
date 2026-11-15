// `runway destroy`: remove everything runway created in the account, including what lives
// outside the stack (Lambda runner functions, MicroVM images, SSM parameters, the bucket).
import { createInterface } from 'node:readline/promises';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DeleteFunctionCommand, LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import {
  DeleteMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  ListMicrovmsCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { microvmImageName } from '../core/images.js';
import {
  appParam,
  bucketName,
  deleteParam,
  deleteStack,
  emptyAndDeleteBucket,
  getSecureJson,
  imagesParam,
  resolveTarget,
} from './aws.js';
import type { StoredApp } from './github-app.js';
import { bold, CliError, dim, ok, warn } from './ui.js';

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
  const ssm = new SSMClient({ region: t.region });
  const app = await getSecureJson<StoredApp>(ssm, appParam(t.stack));

  const lambda = new LambdaClient({ region: t.region });
  const prefix = `runway-${t.stack}-runner-`;
  let Marker: string | undefined;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker }));
    for (const fn of page.Functions ?? []) {
      if (fn.FunctionName?.startsWith(prefix)) {
        await lambda.send(new DeleteFunctionCommand({ FunctionName: fn.FunctionName }));
        ok(`Deleted runner function ${fn.FunctionName}`);
      }
    }
    Marker = page.NextMarker;
  } while (Marker);

  const microvms = new LambdaMicrovmsClient({ region: t.region });
  const images = (await microvms.send(new ListMicrovmImagesCommand({}))).items ?? [];
  for (const img of images.filter((i) => i.name?.startsWith(microvmImageName(t.stack, '')))) {
    const vms =
      (await microvms.send(new ListMicrovmsCommand({ imageIdentifier: img.imageArn }))).items ?? [];
    for (const vm of vms.filter((v) => v.state !== 'TERMINATED' && v.microvmId)) {
      await microvms
        .send(new TerminateMicrovmCommand({ microvmIdentifier: vm.microvmId }))
        .catch(() => {});
    }
    try {
      await microvms.send(new DeleteMicrovmImageCommand({ imageIdentifier: img.imageArn }));
      ok(`Deleted MicroVM image ${img.name}`);
    } catch (e) {
      warn(`Couldn't delete MicroVM image ${img.name}: ${(e as Error).message}`);
    }
  }

  await deleteStack(new CloudFormationClient({ region: t.region }), t.stack);
  await deleteParam(ssm, imagesParam(t.stack));
  await deleteParam(ssm, appParam(t.stack));
  await emptyAndDeleteBucket(new S3Client({ region: t.region }), bucketName(t));
  ok('Deleted parameters and the assets bucket');

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
