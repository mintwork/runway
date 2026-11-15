# AGENTS.md

Guidance for AI coding agents working on **runway**: run GitHub Actions jobs on your own AWS compute
(Lambda MicroVMs, EC2, ECS Fargate, Lambda functions), chosen per job with `runs-on` labels.

## Commands

```bash
npm install
npm run check        # generate sources + typecheck, biome lint, vitest, Python agent tests
npm run build        # dist/cli.js, dist/assets/functions.zip, dist/runway.template.yaml
npm run gen          # regenerate src/generated/sources.ts (also runs before typecheck/test/build)
node dist/cli.js --help
npm run demo:gif     # rebuild docs/demo.gif (needs Google Chrome + ffmpeg; replays a real install, no AWS)
```

CloudFormation: `pipx install cfn-lint && cfn-lint -- dist/runway.template.yaml` (CI does this).

## Layout

- `src/core/labels.ts`: `runs-on` labels → `JobSpec`, plus `specFor()` for fallback sizing. Unknown labels are errors on purpose.
- `src/core/dispatch.ts`: what happens per `workflow_job` event (`handleQueued`, `handleInProgress`, `handleCompleted`) and the periodic `sweep`. Pure orchestration; everything is injected and unit-tested.
- `src/core/github.ts`: dependency-free GitHub App client (JWT, installation tokens, JIT runner configs, signature check).
- `src/core/state.ts`: the DynamoDB table (job claims for dedupe, one item per runner).
- `src/core/images.ts`: runner image builds (MicroVM image via the Lambda MicroVMs API, Fargate/Lambda images via CodeBuild), shared by the CLI and the maintainer.
- `src/core/webhook-ingress.ts`: the API Gateway allowlist of GitHub's webhook ranges.
- `src/providers/`: one file per compute type, all implementing `Provider` (`launch`, `terminate`, `listManaged`). Throw `CapacityError` for "no capacity / quota", anything else is a real error.
- `src/lambda/`: the four Lambda handlers (`webhook`, `worker`, `sweeper`, `maintainer`) and `runtime.ts` wiring.
- `src/cli/`: `setup`/`update` (`deploy.ts`), `status`, `destroy`, the GitHub App manifest flow.
- `agent/runway_agent.py`: the runner agent, the same file on every compute type. **Python 3.9, stdlib only** (Amazon Linux 2023).
- `images/`: Dockerfiles, the shared `install-runner.sh`, the CodeBuild buildspec.
- `template/runway.yaml` + `template/environment.yaml`: the stack. The environment block is expanded into each function by `scripts/gen-sources.mjs` (CloudFormation has no YAML anchors).

## Conventions and gotchas

- Lambda runtime is `nodejs24.x` (the newest GA runtime); switch the `LambdaRuntime` default when `nodejs26.x` is GA.
- `RunMicrovm`'s `runHookPayload` is capped at **4096 bytes** in practice, so MicroVMs get their JIT config through a presigned S3 URL. Don't put the JIT config in the payload.
- Nothing job-specific may happen before the MicroVM `/run` hook: every MicroVM resumes from the same snapshot.
- The webhook is behind API Gateway with a GitHub-IP allowlist, and the function has no public permission. Don't switch back to a public Function URL: many accounts auto-remove public Lambda permissions.
- CI workflows use Node 26, the latest action majors and `ubuntu-26.04`.
- Never put real GitHub App keys, webhook secrets or JIT configs in tests or logs.
