// CloudFormation custom resource (Custom::RunwayBootstrap).
//
//   Create/Update: upload the EC2 agent and start the first image builds. Fast: the builds
//                  run on their own (the maintainer starts them).
//   Delete:        remove what runway created outside the stack (MicroVMs and their images,
//                  Lambda runner functions, SSM parameters, the data bucket's objects), so
//                  deleting the stack in the console really uninstalls runway.
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
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
import { DeleteParameterCommand, GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
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
    params: ['github-app', 'images'].map((p) => `/runway/${stack}/${p}`),
    /** Left by 0.1.x, whose setup page lived in the stack. */
    legacySetupToken: `/runway/${stack}/setup-token`,
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

/** EC2 Spot and ECS create these on first use, but only for callers allowed to create IAM roles. */
async function ensureServiceLinkedRoles(): Promise<void> {
  const iam = new IAMClient({});
  // eslint-disable-next-line security-node/detect-unhandled-async-errors -- errors propagate to the caller, which reports them
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
  await ssm.send(new DeleteParameterCommand({ Name: n.legacySetupToken })).catch(() => {});
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
  return {};
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
  // Lambda creates a log group for each runner function on first use; the stack doesn't own them.
  const logs = new CloudWatchLogsClient({});
  let nextToken: string | undefined;
  do {
    const page = await logs.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: `/aws/lambda/${n.runnerPrefix}`,
        nextToken,
      }),
    );
    for (const g of page.logGroups ?? []) {
      if (g.logGroupName)
        await logs
          .send(new DeleteLogGroupCommand({ logGroupName: g.logGroupName }))
          .catch(() => {});
    }
    nextToken = page.nextToken;
  } while (nextToken);
  for (const Name of [...n.params, n.legacySetupToken])
    await ssm.send(new DeleteParameterCommand({ Name })).catch(() => {});
  let ContinuationToken: string | undefined;
  // eslint-disable-next-line security-node/detect-unhandled-async-errors -- errors propagate to the caller, which reports them
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
    Data: data,
  });
  // CloudFormation's presigned response URL for this custom resource; it's meant to be called.
  // nosemgrep
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
