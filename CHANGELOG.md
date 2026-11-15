# Changelog

## Unreleased

- **`update` keeps your options.** Options you leave out keep the stack's current values instead of
  going back to the defaults (before, a plain `update` reset `--fallback`, `--runner-policy`,
  `--allow-public-repos`, `--max-job-minutes`, `--microvm-sizes` and `--default-compute`).
  `--no-allow-public-repos` turns public repositories off again.
- README rewritten: demo GIF, a full first workflow, what's on each runner, what setup creates,
  options table, upgrading, uninstalling and troubleshooting.

## 0.2.1

- Runner images and EC2 runners include `libatomic`, so `actions/setup-node` with Node.js 26 works
  as it does on GitHub's hosted runners (it failed with exit code 127 on Fargate).

## 0.2.0

- **No public setup page.** `runway setup` creates the GitHub App from your terminal: it serves the
  page on `127.0.0.1`, GitHub sends the App's key back to the CLI, and the CLI stores it in SSM. The
  stack's setup page, its Lambda function and the setup token are gone, and the API's policy now
  admits only `POST /` from GitHub's webhook ranges. Updating a 0.1.x stack removes them.
- Setup is run from a terminal on your own machine; the CloudShell instructions are gone (CloudShell
  has no browser to open the local page).
- `setup` waits for the first image builds instead of reporting them built as soon as they start.
- `--profile <name>` on every command picks an AWS profile (otherwise `AWS_PROFILE` or the default).
- When AWS's sign-in service fails (it answers with an error page), the CLI says so instead of
  telling you to log in again.

## 0.1.1

Fixes found by onboarding from scratch with 0.1.0.

- Jobs queued before the runner images finish building now wait ("still being built") and launch
  as soon as the image is ready, instead of failing or starting a Fargate task with no image.
- If a runner's machine stops before it takes its job, the sweeper queues the job again instead of
  leaving it stuck. Queued jobs are retried for about 90 minutes.
- The first image build could fail silently (the maintainer couldn't list the custom tools prefix);
  fixed, and `setup` now starts the builds itself if they haven't started after 2 minutes.
- The public page shown after installing the App no longer names your org or App.
- All commands use `npx -y`, so npx doesn't stop to ask before installing.

## 0.1.0

First release.

- `npx @mintwork/runway setup` deploys runway into your AWS account and builds the runner images.
  A setup page served by your own stack creates the GitHub App in one click; GitHub hands the App's
  key to your stack, never to a browser. Works from any machine, including CloudShell and SSH.
  `status`, `update` and `destroy` manage it; deleting the stack also removes everything runway made.
- Four compute types, chosen per job with `runs-on` labels: Lambda MicroVMs (Docker included), EC2
  (any instance type, Spot with on-demand fallback), ECS Fargate and Lambda functions. Sizes,
  architecture (x64, arm64) and disk are labels too; unknown labels are refused, never ignored.
- One single-use (just-in-time) runner per job on its own machine, ended when the job completes.
- Fallback between compute types when one has no capacity (default `microvm:ec2`), and queued
  retries when none has.
- A sweeper that ends machines past the time limit, runners whose job was cancelled, and anything
  tagged for the stack without a record.
- Weekly image rebuilds when GitHub ships a new runner, verified against its published SHA-256.
- Refused jobs get a failed **runway** check on the commit saying why, with "did you mean" for
  label typos, and `runway status` lists them.
- Your own tools on every runner: `runway update --runner-tools ./runner-tools.sh` bakes a script
  into the images (EC2 runs it at boot). See docs/custom-tools.md.
- Webhook behind API Gateway, admitting only GitHub's webhook ranges, plus an HMAC check on every
  delivery. Public repositories are refused by default; runs from forks always.
