// CloudFormation custom resource (Custom::RunwayBootstrap).
//
//   Create/Update: issue a one-time setup token while no GitHub App exists (it becomes the
//                  stack's SetupUrl output), upload the EC2 agent, and start the first image
//                  builds. Fast: the builds run on their own (the maintainer starts them).
//   Delete:        remove what runway created outside the stack (MicroVMs and their images,
//                  Lambda runner functions, SSM parameters, the data bucket's objects), so
//                  deleting the stack in the console really uninstalls runway.
import { randomBytes } from 'node:crypto';
import { CreateServiceLinkedRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import {
  DeleteFunctionCommand,
  InvokeCommand,
  LambdaClient,
  ListFunctionsCommand,
} from '@aws-sdk/client-lambda';
import {
  DeleteMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  ListMicrovmsCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';
import { microvmImageName } from '../core/images.js';
import * as sources from '../generated/sources.js';

const ssm = new SSMClient({});
const s3 = new S3Client({});
const lambda = new LambdaClient({});
const microvms = new LambdaMicrovmsClient({});

const names = () => {
  const stack = process.env.RUNWAY_STACK as string;
  return {
    stack,
    bucket: process.env.RUNWAY_ASSETS_BUCKET as string,
    maintainer: `runway-${stack}-maintainer`,
    runnerPrefix: `runway-${stack}-runner-`,
    params: ['github-app', 'images', 'setup-token'].map((p) => `/runway/${stack}/${p}`),
  };
};

async function exists(name: string): Promise<boolean> {
  try {
    await ssm.send(new GetParameterCommand({ Name: name }));
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'ParameterNotFound') return false;
    throw e;
  }
}

async function getOrCreateSetupToken(stack: string): Promise<string> {
  const Name = `/runway/${stack}/setup-token`;
  try {
    return (
      (await ssm.send(new GetParameterCommand({ Name, WithDecryption: true }))).Parameter?.Value ??
      ''
    );
  } catch (e) {
    if ((e as { name?: string }).name !== 'ParameterNotFound') throw e;
  }
  const token = randomBytes(24).toString('base64url');
  await ssm.send(
    new PutParameterCommand({ Name, Type: 'SecureString', Value: token, Overwrite: false }),
  );
  return token;
}

/** EC2 Spot and ECS create these on first use, but only for callers allowed to create IAM roles. */
async function ensureServiceLinkedRoles(): Promise<void> {
  const iam = new IAMClient({});
  for (const AWSServiceName of ['spot.amazonaws.com', 'ecs.amazonaws.com']) {
    await iam.send(new CreateServiceLinkedRoleCommand({ AWSServiceName })).catch((e: Error) => {
      if (!/has been taken|already exists/i.test(e.message)) throw e;
    });
  }
}

async function createOrUpdate(): Promise<Record<string, string>> {
  const n = names();
  await ensureServiceLinkedRoles();
  await s3.send(
    new PutObjectCommand({
      Bucket: n.bucket,
      Key: 'runway/agent/runway_agent.py',
      Body: sources.agent,
    }),
  );
  const hasApp = await exists(`/runway/${n.stack}/github-app`);
  const token = hasApp ? 'done' : await getOrCreateSetupToken(n.stack);
  if (!(await exists(`/runway/${n.stack}/images`))) {
    // Fire and forget: image builds take minutes, a custom resource must answer quickly.
    await lambda.send(
      new InvokeCommand({
        FunctionName: n.maintainer,
        InvocationType: 'Event',
        Payload: Buffer.from('{"force":true}'),
      }),
    );
  }
  return { SetupToken: token };
}

async function cleanUp(): Promise<void> {
  const n = names();
  const images = (await microvms.send(new ListMicrovmImagesCommand({}))).items ?? [];
  for (const img of images.filter((i) => i.name?.startsWith(microvmImageName(n.stack, '')))) {
    const vms =
      (await microvms.send(new ListMicrovmsCommand({ imageIdentifier: img.imageArn }))).items ?? [];
    for (const vm of vms.filter((v) => v.state !== 'TERMINATED' && v.microvmId)) {
      await microvms
        .send(new TerminateMicrovmCommand({ microvmIdentifier: vm.microvmId }))
        .catch(() => {});
    }
    await microvms
      .send(new DeleteMicrovmImageCommand({ imageIdentifier: img.imageArn }))
      .catch((e) => console.log(`could not delete ${img.name}: ${e}`));
  }
  let Marker: string | undefined;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker }));
    for (const fn of page.Functions ?? []) {
      if (fn.FunctionName?.startsWith(n.runnerPrefix))
        await lambda.send(new DeleteFunctionCommand({ FunctionName: fn.FunctionName }));
    }
    Marker = page.NextMarker;
  } while (Marker);
  for (const Name of n.params) await ssm.send(new DeleteParameterCommand({ Name })).catch(() => {});
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: n.bucket, ContinuationToken }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key as string }));
    if (keys.length)
      await s3.send(new DeleteObjectsCommand({ Bucket: n.bucket, Delete: { Objects: keys } }));
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
}

async function respond(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  status: 'SUCCESS' | 'FAILED',
  data: Record<string, string>,
  reason?: string,
) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason ?? `See CloudWatch log stream ${context.logStreamName}`,
    PhysicalResourceId:
      'PhysicalResourceId' in event
        ? event.PhysicalResourceId
        : `runway-bootstrap-${process.env.RUNWAY_STACK}`,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    // The setup token is an output only you (account users who can read stack outputs) see.
    NoEcho: false,
    Data: data,
  });
  await fetch(event.ResponseURL, { method: 'PUT', body, headers: { 'content-type': '' } });
}

export async function handler(
  event: CloudFormationCustomResourceEvent,
  context: Context,
): Promise<void> {
  try {
    if (event.RequestType === 'Delete') {
      await cleanUp();
      await respond(event, context, 'SUCCESS', {});
    } else {
      await respond(event, context, 'SUCCESS', await createOrUpdate());
    }
  } catch (e) {
    console.error(e);
    // Never block deleting the stack on cleanup trouble; report creation failures properly.
    if (event.RequestType === 'Delete')
      await respond(event, context, 'SUCCESS', {}, `cleanup incomplete: ${(e as Error).message}`);
    else await respond(event, context, 'FAILED', {}, (e as Error).message.slice(0, 500));
  }
}
