// AWS steps of `runway setup` / `update` / `destroy`.
import { createHash } from 'node:crypto';
import {
  type CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  type Parameter,
  type Stack,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketEncryptionCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { CliError, progress } from './ui.js';

export interface Target {
  region: string;
  account: string;
  stack: string;
}

export async function resolveTarget(region: string | undefined, stack: string): Promise<Target> {
  const r = region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!r)
    throw new CliError(
      'No AWS region. Pass --region (for example --region eu-central-1) or set AWS_REGION.',
    );
  if (!/^[a-z0-9-]{1,40}$/.test(stack))
    throw new CliError('--stack must be lowercase letters, digits and dashes');
  try {
    const id = await new STSClient({ region: r }).send(new GetCallerIdentityCommand({}));
    return { region: r, account: id.Account as string, stack };
  } catch (e) {
    throw new CliError(
      `Can't use your AWS credentials (${(e as Error).message}). Log in first, for example with: aws sso login`,
    );
  }
}

export const bucketName = (t: Target) => `runway-${t.stack}-${t.account}-${t.region}`;
export const appParam = (stack: string) => `/runway/${stack}/github-app`;
export const imagesParam = (stack: string) => `/runway/${stack}/images`;

export async function ensureBucket(s3: S3Client, t: Target): Promise<string> {
  const Bucket = bucketName(t);
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
    return Bucket;
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404)
      throw e;
  }
  await s3.send(
    new CreateBucketCommand({
      Bucket,
      ...(t.region === 'us-east-1'
        ? {}
        : { CreateBucketConfiguration: { LocationConstraint: t.region as never } }),
    }),
  );
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    }),
  );
  return Bucket;
}

/** Upload with a content hash in the key, so CloudFormation sees a change exactly when the code changes. */
export async function uploadHashed(
  s3: S3Client,
  bucket: string,
  prefix: string,
  ext: string,
  body: Uint8Array | string,
): Promise<string> {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const Key = `${prefix}-${hash}${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: body }));
  return Key;
}

export async function describeStack(
  cf: CloudFormationClient,
  name: string,
): Promise<Stack | undefined> {
  try {
    return (await cf.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
  } catch (e) {
    if (/does not exist/.test((e as Error).message)) return undefined;
    throw e;
  }
}

export function outputs(stack: Stack): Record<string, string> {
  return Object.fromEntries(
    (stack.Outputs ?? []).map((o) => [o.OutputKey as string, o.OutputValue as string]),
  );
}

const DONE = /_(COMPLETE|FAILED)$/;

async function waitForStack(
  cf: CloudFormationClient,
  name: string,
  label: string,
  since: Date,
): Promise<Stack> {
  const p = progress(label);
  for (;;) {
    const stack = await describeStack(cf, name);
    const status = stack?.StackStatus ?? 'DELETE_COMPLETE';
    p.update(status.toLowerCase().replaceAll('_', ' '));
    if (DONE.test(status) && !status.endsWith('_IN_PROGRESS')) {
      const good =
        status === 'CREATE_COMPLETE' ||
        status === 'UPDATE_COMPLETE' ||
        status === 'DELETE_COMPLETE';
      if (good) {
        p.done(`${label}: ${status.toLowerCase().replaceAll('_', ' ')}`);
        return stack as Stack;
      }
      p.done(`${label}: ${status}`, false);
      const events = await cf.send(
        new DescribeStackEventsCommand({ StackName: stack?.StackId ?? name }),
      );
      const reasons = (events.StackEvents ?? [])
        .filter(
          (e) =>
            (e.Timestamp ?? since) >= since &&
            /FAILED/.test(e.ResourceStatus ?? '') &&
            e.ResourceStatusReason,
        )
        .slice(0, 5)
        .map((e) => `${e.LogicalResourceId}: ${e.ResourceStatusReason}`);
      throw new CliError(
        `Stack ${name} failed.\n    ${reasons.join('\n    ') || 'See the CloudFormation console for details.'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function deployStack(
  cf: CloudFormationClient,
  name: string,
  templateUrl: string,
  params: Record<string, string>,
): Promise<Stack> {
  const Parameters: Parameter[] = Object.entries(params).map(([ParameterKey, ParameterValue]) => ({
    ParameterKey,
    ParameterValue,
  }));
  const existing = await describeStack(cf, name);
  const since = new Date();
  const common = {
    StackName: name,
    TemplateURL: templateUrl,
    Parameters,
    Capabilities: ['CAPABILITY_IAM' as const],
    Tags: [{ Key: 'runway:stack', Value: name }],
  };
  if (existing?.StackStatus === 'ROLLBACK_COMPLETE') {
    throw new CliError(
      `Stack ${name} is in ROLLBACK_COMPLETE from a failed first deploy. Run "runway destroy --stack ${name}" and set up again.`,
    );
  }
  if (!existing) {
    await cf.send(new CreateStackCommand({ ...common, OnFailure: 'ROLLBACK' }));
    return waitForStack(cf, name, `Creating stack ${name}`, since);
  }
  try {
    await cf.send(new UpdateStackCommand(common));
  } catch (e) {
    if (/No updates are to be performed/.test((e as Error).message)) return existing;
    throw e;
  }
  return waitForStack(cf, name, `Updating stack ${name}`, since);
}

export async function deleteStack(cf: CloudFormationClient, name: string): Promise<void> {
  const existing = await describeStack(cf, name);
  if (!existing) return;
  const since = new Date();
  await cf.send(new DeleteStackCommand({ StackName: name }));
  await waitForStack(cf, existing.StackId as string, `Deleting stack ${name}`, since);
}

export async function emptyAndDeleteBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker, VersionIdMarker }),
      );
      const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({
        Key: v.Key as string,
        VersionId: v.VersionId,
      }));
      if (objects.length)
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      KeyMarker = page.NextKeyMarker;
      VersionIdMarker = page.NextVersionIdMarker;
    } while (KeyMarker || VersionIdMarker);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'NoSuchBucket') throw e;
  }
}

export async function getSecureJson<T>(ssm: SSMClient, name: string): Promise<T | undefined> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return JSON.parse(res.Parameter?.Value ?? '') as T;
  } catch (e) {
    if ((e as { name?: string }).name === 'ParameterNotFound') return undefined;
    throw e;
  }
}

export async function putSecureJson(ssm: SSMClient, name: string, value: unknown): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Type: 'SecureString',
      Overwrite: true,
      Value: JSON.stringify(value),
      Tier: 'Standard',
    }),
  );
}

export async function deleteParam(ssm: SSMClient, name: string): Promise<void> {
  try {
    await ssm.send(new DeleteParameterCommand({ Name: name }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'ParameterNotFound') throw e;
  }
}
