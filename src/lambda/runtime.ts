// Shared wiring for the Lambda handlers: real clients, cached secrets and image registry.
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { type Config, type ImageRegistry, loadConfig } from '../core/config.js';
import type { Deps } from '../core/dispatch.js';
import { type AppCredentials, GitHubApp } from '../core/github.js';
import { State } from '../core/state.js';
import { Ec2Provider } from '../providers/ec2.js';
import { FargateProvider } from '../providers/fargate.js';
import { LambdaProvider } from '../providers/lambda.js';
import { MicrovmProvider } from '../providers/microvm.js';

const ssm = new SSMClient({});
const sqs = new SQSClient({});
const cache = new Map<string, { value: string; at: number }>();

/** SSM parameters are cached for a minute, so config changes reach warm functions quickly. */
export async function parameter(name: string, decrypt = false): Promise<string> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty`);
  cache.set(name, { value, at: Date.now() });
  return value;
}

export async function appCredentials(config: Config): Promise<AppCredentials> {
  return JSON.parse(await parameter(config.appParam, true)) as AppCredentials;
}

let deps: Deps | undefined;
let github: { app: GitHubApp; creds: string } | undefined;

export async function runtimeDeps(): Promise<Deps> {
  const config = loadConfig();
  const credsJson = await parameter(config.appParam, true);
  // Recreate the GitHub client only when the stored credentials change.
  if (!github || github.creds !== credsJson) {
    github = { app: new GitHubApp(JSON.parse(credsJson) as AppCredentials), creds: credsJson };
  }
  if (!deps) {
    const images = async () => JSON.parse(await parameter(config.imagesParam)) as ImageRegistry;
    deps = {
      config,
      github: github.app,
      state: new State(config.table),
      providers: {
        microvm: new MicrovmProvider(config, images),
        ec2: new Ec2Provider(config, images),
        fargate: new FargateProvider(config),
        lambda: new LambdaProvider(config, images),
      },
      log,
      requeue: async (job) => {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: config.queueUrl,
            MessageBody: JSON.stringify({ type: 'queued', ...job }),
          }),
        );
      },
    };
  }
  deps.github = github.app;
  return deps;
}

export function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', message, ...fields }));
}
