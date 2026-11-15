<div align="center">

# runway

**Run GitHub Actions jobs on your own AWS compute. Pick the machine per job.**

`npx -y @mintwork/runway setup --owner <your-org> --region eu-central-1`

Lambda MicroVMs · EC2 (on-demand and Spot) · ECS Fargate · Lambda functions · one `runs-on` line · MIT

[![CI](https://github.com/mintwork/runway/actions/workflows/ci.yml/badge.svg)](https://github.com/mintwork/runway/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mintwork/runway?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@mintwork/runway) [![npm provenance](https://img.shields.io/badge/provenance-signed-7EE2B8?labelColor=0D1714&logo=sigstore&logoColor=white)](https://www.npmjs.com/package/@mintwork/runway#provenance) [![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/mintwork/runway?style=social)](https://github.com/mintwork/runway/stargazers)

</div>

---

```yaml
jobs:
  test:
    runs-on: [runway, microvm, 2cpu] # a fresh Firecracker VM, Docker included
  build:
    runs-on: [runway, ec2, spot, arm64, 8cpu] # Graviton Spot instance, falls back to on-demand
  lint:
    runs-on: [runway, lambda] # a Lambda function: starts fast, costs fractions of a cent
  e2e:
    runs-on: [runway, fargate, x64, 4cpu, 16gb]
```

One setup command puts a small dispatcher in your AWS account. Every job that asks for `runway`
gets its own machine, launched for that job, registered as a single-use runner, and ended the moment
the job finishes. Nothing runs (or bills) between jobs.

- **Your account, your network.** Jobs run in a VPC runway creates, with the IAM permissions you choose.
- **The right machine per job.** Four compute types, any size, x64 or arm64, Spot when you want it.
- **One job per machine.** Every job gets a fresh MicroVM, instance, task or Lambda sandbox. Nothing is reused.
- **A locked-down webhook.** Only GitHub's webhook IP ranges get through, every delivery must carry a valid signature, and runners accept no inbound connections.
- **No long-lived secrets.** A GitHub App with the narrowest permission that works, and single-use runner tokens.
- **Nothing to babysit.** Images rebuild weekly when GitHub ships a new runner, and a sweeper ends anything left behind.

## Quick start

You need permission to create a CloudFormation stack with IAM roles in your AWS account (an admin
role is simplest), and owner rights on the GitHub organization or account.

**Easiest: in AWS CloudShell.** It's already logged in to your account, so there's nothing to install.
Open it in the region you want runway in, and paste one line:

<a href="https://console.aws.amazon.com/cloudshell/home"><img src="https://mintwork.github.io/assets/open-in-cloudshell.svg" alt="Open in AWS CloudShell" width="320" height="60"></a>

```bash
npx -y @mintwork/runway setup --owner <github-org-or-user>
```

**Or from any machine with AWS credentials** (your laptop, a CI job), adding the region:

```bash
npx -y @mintwork/runway setup --owner <github-org-or-user> --region eu-central-1
```

Setup takes about 10 minutes:

1. The CLI uploads runway's code to a bucket in your account and deploys the runway stack: a webhook,
   a queue, the dispatcher, a VPC and one role per compute type. The stack starts building the
   runner images right away.
2. The CLI opens the **setup page**, served by your own stack (any browser works, so CloudShell and
   SSH are fine: open the printed link). It creates runway's GitHub App on your organization in one click, then sends you on to install it on the repositories you choose. GitHub hands the App's
   private key to your stack, which keeps it in SSM; it never passes through your browser or mintwork.
3. The CLI (and the setup page) show the images building. Jobs that start earlier wait for them.

Then use `runs-on: [runway]` in any workflow of those repositories. Check on it with
`npx -y @mintwork/runway status`. Need more tools on the runners? See [custom tools](docs/custom-tools.md).

## Choosing the machine

`runs-on` takes `runway` plus any of these labels. Unknown labels are an error (the job is
refused and `runway status` says why), so a typo never silently runs on the wrong machine.

| Label                                 | Meaning                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `microvm`, `ec2`, `fargate`, `lambda` | Compute type. Without one, the stack default (`microvm`)                         |
| `arm64`, `x64`                        | Architecture. Default: `arm64` for MicroVM and Lambda, `x64` for EC2 and Fargate |
| `2cpu`, `8gb`                         | vCPUs and memory. runway picks the smallest machine that fits                    |
| `disk-100gb`                          | Disk size (EC2 and Fargate)                                                      |
| `spot`                                | EC2 Spot, trying several instance families, then on-demand                       |
| `c7g.2xlarge`, `m7i.4xlarge`, ...     | An exact EC2 instance type (implies `ec2`)                                       |

### The four compute types

|                   | Lambda MicroVM                          | EC2                              | ECS Fargate             | Lambda function           |
| ----------------- | --------------------------------------- | -------------------------------- | ----------------------- | ------------------------- |
| Best for          | most CI jobs, Docker builds             | big builds, long jobs            | containers in your VPC  | lint, unit tests, scripts |
| Job running after | ~25 s                                   | ~60 s (installs the runner)      | ~30 s                   | ~35 s                     |
| Docker            | ✅                                      | ✅                               | ❌                      | ❌                        |
| Max job length    | 8 h                                     | your limit (default 6 h)         | your limit              | 15 min                    |
| Sizes             | 1, 2 or 4 vCPU baseline, bursting to 4× | any instance type                | 1–16 vCPU, up to 120 GB | up to 6 vCPU, 10 GB       |
| Architecture      | arm64, x64 (with an x64 image)          | x64, arm64                       | x64, arm64              | x64, arm64                |
| Billing           | per second, while running               | per second (Spot: up to 90% off) | per second              | per millisecond           |

**Fallback.** When a compute type has no capacity (or a quota is used up), runway moves the job to
the next one in the chain, sized to fit: by default `microvm:ec2`. When nothing has capacity, the job
waits and runway retries every 30 seconds for up to about 90 minutes, so a burst of jobs queues instead of failing. Change it
with `--fallback microvm:ec2,ec2:fargate`.

Startup times are from the launch call until the job's first step, measured in eu-central-1 at
the default sizes. A Lambda size runs ~25 s slower the first time, while runway creates its function.

> **MicroVM quota.** How many MicroVMs run at once is set by your account's MicroVM memory quota
> (2 GB per baseline vCPU). `runway setup` and `runway status` show yours and warn when it's low;
> jobs beyond it go to the fallback compute or wait.

## How it works

```
GitHub ──workflow_job webhook──▶ API Gateway (GitHub IPs only) ──▶ Lambda (verify signature) ──▶ SQS ──▶ worker
                                                                          │ 1. single-use JIT runner config from GitHub
                                                                          │ 2. launch: MicroVM │ EC2 │ Fargate │ Lambda
                                                                          ▼
                         the machine runs the runway agent ──▶ runs exactly one job ──▶ exits
GitHub ──workflow_job completed──▶ worker terminates the machine     sweeper (every 2 min) ends leftovers
```

- **Webhook**: API Gateway admits only [GitHub's webhook ranges](https://api.github.com/meta), then a Lambda function checks every delivery's HMAC signature, keeps `workflow_job` events with the `runway` label and queues them. The function has no public permission.
- **Worker**: checks policy (allowed owners, public repositories, forks), parses labels, asks GitHub for a
  [just-in-time runner](https://docs.github.com/actions/hosting-your-own-runners/managing-self-hosted-runners/autoscaling-with-self-hosted-runners#using-just-in-time-runners) config,
  launches the machine, and records it in DynamoDB. Redelivered webhooks never launch twice.
- **Agent** ([`agent/runway_agent.py`](agent/runway_agent.py)): one small Python file, the same on every compute type. It runs the runner for one job, keeps agent settings out of job steps, and stops a runner that never gets a job.
- **Sweeper**: every 2 minutes ends machines past the time limit, machines whose job was cancelled before it started, and anything tagged for this stack that runway has no record of.
- **Maintainer**: weekly, rebuilds the images when GitHub ships a new runner (and at least monthly for OS patches).

## Security

- **Isolation.** One job per machine: a Firecracker MicroVM, an EC2 instance, a Fargate task, or a Lambda
  execution environment that the agent discards after the job. Jobs never share a machine.
- **GitHub permissions.** The App gets only _Self-hosted runners: write_ for organizations
  (_Administration: write_ for personal accounts, which GitHub requires for repository runners),
  _Checks: write_ (to explain refused jobs on the commit), and _Actions: read_ and _Metadata: read_.
  Its private key is an SSM SecureString.
- **Setup page.** It answers only with your stack's one-time setup token, verifies that GitHub's
  callback started on that page, and closes once the App exists.
- **Public repositories are refused** unless you pass `--allow-public-repos`, and runs from forks are
  always refused: a pull request from a stranger must never run on your AWS account.
- **AWS permissions.** Runners get no AWS permissions by default. Give jobs exactly what they need with
  `--runner-policy arn:aws:iam::aws:policy/ReadOnlyAccess,...`. The dispatcher can only terminate
  instances tagged for its own stack.
- **Network.** Runners accept no inbound connections; they dial out to GitHub and package registries.
- **Webhook.** API Gateway refuses any source outside GitHub's published webhook ranges (refreshed
  weekly), and the function rejects any delivery without a valid signature. The webhook secret and the
  App's private key live only in one SSM SecureString.

## Cost

You pay AWS for the machines while jobs run, plus pennies for the dispatcher (Lambda, SQS, DynamoDB on
demand). There is no runway fee. Idle cost is close to zero: no instances wait for jobs. Image storage
(ECR keeps the last 12 builds; old MicroVM image versions are deleted on each rebuild) is a few dollars a month. MicroVM pricing:
[AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/).

## Commands

```bash
npx -y @mintwork/runway setup --owner <org> --region <region>   # first install (safe to re-run)
npx -y @mintwork/runway status                                  # health, images, quota, recent runners and refusals
npx -y @mintwork/runway update [--rebuild-images]               # deploy a new version / change options
npx -y @mintwork/runway destroy                                 # remove everything runway created

# Deleting the stack in the CloudFormation console also removes everything runway created.
```

Options: `--default-compute`, `--fallback`, `--max-job-minutes`, `--microvm-sizes arm64-1cpu,arm64-2cpu`,
`--runner-policy`, `--runner-tools ./runner-tools.sh`, `--allow-public-repos`, `--stack` (several
independent setups), `--no-browser`.
Run `npx -y @mintwork/runway --help` for all of them.

## Limits, honestly

- **Images are not GitHub's.** Runner images have git, Docker (MicroVM, EC2), the AWS CLI, Python and
  the runner's own Node, not GitHub's hundreds of preinstalled tools. Add yours once with a
  [`runner-tools.sh`](docs/custom-tools.md), or per job with `actions/setup-node` and friends.
- **One MicroVM image per size and architecture.** Setup builds `arm64-1cpu`; add more with
  `--microvm-sizes arm64-1cpu,arm64-2cpu,x64-1cpu` (x64 needs an x86 MicroVM quota in your account).
  A job asking for a size without an image goes to the fallback.
- **Lambda jobs end at 15 minutes** and have no Docker. Use them for quick jobs.
- **Fargate has no Docker daemon** (no privileged containers).
- **EC2 starts in about a minute** because it installs the runner at boot, and uses the stock Amazon
  Linux AMI: no GPU drivers yet.
- **A refused job waits in GitHub.** runway can't fail a job it won't run, so a job with a bad label
  or from a refused repository stays queued until you cancel it. It does post a failed **runway**
  check on the commit saying why (with a "did you mean" for typos), and `runway status` lists refusals.

## How is this different from…

- **[RunsOn](https://runs-on.com)**: excellent EC2 runners in your account; commercial licence for companies. runway is MIT and adds MicroVMs, Fargate and Lambda.
- **[terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner)**: the established EC2 module for large fleets, configured with Terraform. runway is one command and four compute types.
- **[AWS CodeBuild runners](https://docs.aws.amazon.com/codebuild/latest/userguide/action-runner.html)**: AWS's own, configured per CodeBuild project. runway picks the machine per job from `runs-on`.

## Development

```bash
npm install
npm run check    # typecheck, lint, unit tests (TypeScript and the Python agent)
npm run build    # dist/cli.js and dist/assets/functions.zip
```

[`AGENTS.md`](AGENTS.md) explains the layout. Field-test changes in your own account with
`node dist/cli.js setup --stack dev --owner <you> --region <region>`.

## License

MIT
