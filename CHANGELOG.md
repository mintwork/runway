# Changelog

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
