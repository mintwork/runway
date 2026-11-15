# runway runner image for Lambda MicroVMs.
#
# Lambda builds this (it is not a docker build you push): runway zips this Dockerfile with the
# agent and install script, uploads the zip to S3 and calls create-microvm-image. Lambda runs
# the Dockerfile, starts the agent, waits for its /ready hook and snapshots the VM. Every job's
# MicroVM resumes from that snapshot, so nothing job-specific may happen before /run.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Filled in by runway when it builds the image (the latest runner release and its checksums).
ARG RUNNER_VERSION=__RUNNER_VERSION__
ARG RUNNER_SHA256_ARM64=__RUNNER_SHA256_ARM64__
ARG RUNNER_SHA256_X64=__RUNNER_SHA256_X64__
ARG COMPOSE_VERSION=__COMPOSE_VERSION__

COPY install-runner.sh runner-tools.sh /tmp/
RUN WITH_DOCKER=1 WITH_AWSCLI=1 RUNWAY_TARGET=microvm bash /tmp/install-runner.sh && rm /tmp/install-runner.sh /tmp/runner-tools.sh

# Docker steps wait for the daemon the agent starts at /run (a daemon from the snapshot would
# have stale networking).
COPY wait-for-docker.sh /opt/runway/wait-for-docker.sh
COPY runway_agent.py /opt/runway/runway_agent.py

ENV HOME=/root \
    RUNWAY_DOCKER=1 \
    RUNWAY_HOOK_PORT=9000 \
    ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/runway/wait-for-docker.sh \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1

EXPOSE 9000
# Runs as root on purpose: the agent starts containerd and dockerd, and each MicroVM runs one job
# and is then discarded.
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["python3", "/opt/runway/runway_agent.py", "serve"]
