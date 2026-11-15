// Is a runner image actually there yet? Right after setup the images take ~10 minutes to build,
// and a job launched before then would start a machine that can't run (or a Fargate task whose
// image doesn't exist). Positive answers are cached for a minute; negative ones aren't cached.
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { GetMicrovmImageCommand, type LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';

const ready = new Map<string, number>();
const TTL = 60_000;

async function cached(key: string, check: () => Promise<boolean>): Promise<boolean> {
  const at = ready.get(key);
  if (at && Date.now() - at < TTL) return true;
  const ok = await check();
  if (ok) ready.set(key, Date.now());
  return ok;
}

export function clearReadinessCache(): void {
  ready.clear();
}

/** True once the MicroVM image has a version that can run MicroVMs. */
export function microvmImageReady(client: LambdaMicrovmsClient, arn: string): Promise<boolean> {
  return cached(`microvm:${arn}`, async () => {
    const img = await client.send(new GetMicrovmImageCommand({ imageIdentifier: arn }));
    return Boolean(img.latestActiveImageVersion);
  });
}

/** True once `repositoryUri:tag` exists in ECR. */
export function containerImageReady(
  client: ECRClient,
  repositoryUri: string,
  tag: string,
): Promise<boolean> {
  return cached(`ecr:${repositoryUri}:${tag}`, async () => {
    const repositoryName = repositoryUri.split('/').slice(1).join('/');
    try {
      const res = await client.send(
        new DescribeImagesCommand({ repositoryName, imageIds: [{ imageTag: tag }] }),
      );
      return (res.imageDetails?.length ?? 0) > 0;
    } catch (e) {
      if ((e as { name?: string }).name === 'ImageNotFoundException') return false;
      throw e;
    }
  });
}

export const defaultEcr = (region: string) => new ECRClient({ region });
