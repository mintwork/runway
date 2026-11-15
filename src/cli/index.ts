import { parseArgs } from 'node:util';
import { deploy } from './deploy.js';
import { destroy } from './destroy.js';
import { status } from './status.js';
import { bold, CliError, dim, red } from './ui.js';

declare const __RUNWAY_VERSION__: string;

const HELP = `
  ${bold('runway')} ${dim(`v${__RUNWAY_VERSION__}`)}: run GitHub Actions jobs on your own AWS compute.

  ${bold('Usage')}
    npx @mintwork/runway setup --owner <github-org-or-user> --region <aws-region>
    npx @mintwork/runway status
    npx @mintwork/runway update [--rebuild-images]
    npx @mintwork/runway destroy

  ${bold('Then, in any workflow')}
    runs-on: [runway]                       default compute (Lambda MicroVM unless you change it)
    runs-on: [runway, microvm, 2cpu]        Lambda MicroVM, 2 vCPU baseline, Docker included
    runs-on: [runway, ec2, spot, 8cpu]      EC2 Spot (falls back to on-demand); or an instance type: c7g.2xlarge
    runs-on: [runway, fargate, x64, 4cpu]   ECS Fargate task, add 16gb / disk-100gb as needed
    runs-on: [runway, lambda]               Lambda function: jobs up to 15 minutes, no Docker

  ${bold('Options')}
    --owner <name>            GitHub organization or user whose repositories use runway (setup)
    --region <region>         AWS region (default: AWS_REGION)
    --stack <name>            stack name, for several independent setups (default: runway)
    --default-compute <type>  microvm | ec2 | fargate | lambda (default: microvm)
    --fallback <pairs>        where jobs go when a compute type has no capacity (default: microvm:ec2)
    --max-job-minutes <n>     hard time limit per job (default: 360)
    --microvm-sizes <list>    MicroVM images to build: arm64-1cpu,arm64-2cpu,arm64-4cpu (default: arm64-1cpu)
    --runner-policy <arns>    IAM managed policies your jobs may use, comma-separated (default: none)
    --allow-public-repos      allow jobs from public repositories (forks are always refused)
    --rebuild-images          rebuild runner images now (update)
    --no-wait                 don't wait for image builds to finish
    --no-browser              print links instead of opening the browser
    --yes                     don't ask for confirmation (destroy)
    --limit <n>               runners to list (status, default: 15)

  Docs: https://mintwork.github.io/runway/
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      owner: { type: 'string' },
      region: { type: 'string' },
      stack: { type: 'string', default: 'runway' },
      'default-compute': { type: 'string', default: 'microvm' },
      fallback: { type: 'string', default: 'microvm:ec2' },
      'max-job-minutes': { type: 'string', default: '360' },
      'microvm-sizes': { type: 'string', default: 'arm64-1cpu' },
      'runner-policy': { type: 'string', default: '' },
      'allow-public-repos': { type: 'boolean', default: false },
      'rebuild-images': { type: 'boolean', default: false },
      'no-wait': { type: 'boolean', default: false },
      'no-browser': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      limit: { type: 'string', default: '15' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.version) return void console.log(__RUNWAY_VERSION__);
  const command = positionals[0];
  if (values.help || !command) return void console.log(HELP);

  const common = { region: values.region, stack: values.stack as string };
  const deployOpts = {
    ...common,
    owner: values.owner,
    defaultCompute: values['default-compute'] as string,
    fallback: values.fallback as string,
    allowPublicRepos: values['allow-public-repos'] as boolean,
    maxJobMinutes: Number(values['max-job-minutes']),
    microvmSizes: values['microvm-sizes'] as string,
    runnerPolicies: values['runner-policy'] as string,
    browser: !values['no-browser'],
    rebuildImages: values['rebuild-images'] as boolean,
    wait: !values['no-wait'],
  };
  if (
    !Number.isInteger(deployOpts.maxJobMinutes) ||
    deployOpts.maxJobMinutes < 5 ||
    deployOpts.maxJobMinutes > 2880
  ) {
    throw new CliError('--max-job-minutes must be a whole number from 5 to 2880');
  }
  switch (command) {
    case 'setup':
      return deploy(deployOpts, 'setup');
    case 'update':
      return deploy(deployOpts, 'update');
    case 'status':
      return status({ ...common, limit: Number(values.limit) || 15 });
    case 'destroy':
      return destroy({ ...common, yes: values.yes as boolean });
    default:
      throw new CliError(`Unknown command "${command}". Run: npx @mintwork/runway --help`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof CliError) console.error(`\n  ${red('✗')} ${e.message}\n`);
  else if (
    e instanceof Error &&
    'code' in e &&
    String((e as { code: string }).code).startsWith('ERR_PARSE_ARGS')
  )
    console.error(`\n  ${red('✗')} ${e.message}\n`);
  else console.error(e);
  process.exitCode = 1;
});
