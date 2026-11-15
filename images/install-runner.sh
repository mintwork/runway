#!/bin/bash
# Installs the GitHub Actions runner and common CI tools into an Amazon Linux 2023 image.
# Shared by the MicroVM, Fargate and Lambda runner images so they can't drift apart.
#
#   RUNNER_VERSION, RUNNER_SHA256_ARM64, RUNNER_SHA256_X64   which runner to install (verified)
#   WITH_DOCKER=1     also install Docker Engine, Buildx and Compose (MicroVM images)
#   WITH_AWSCLI=1     also install AWS CLI v2
set -euo pipefail

case "$(uname -m)" in
  aarch64) arch=arm64; sha="$RUNNER_SHA256_ARM64"; compose_arch=aarch64; aws_arch=aarch64 ;;
  x86_64) arch=x64; sha="$RUNNER_SHA256_X64"; compose_arch=x86_64; aws_arch=x86_64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

# Minimal AL2023 images ship curl-minimal, coreutils-single and openssl-snapsafe: asking for
# the full packages conflicts, so only add what's missing. libicu is required by the runner.
packages="libicu lttng-ust krb5-libs zlib ca-certificates git tar gzip xz unzip zip findutils which jq procps-ng hostname python3 sudo shadow-utils openssh-clients"
if [ "${WITH_DOCKER:-0}" = 1 ]; then packages="$packages docker iptables-nft"; fi
dnf install -y --setopt=install_weak_deps=0 $packages
dnf clean all
rm -rf /var/cache/dnf /var/cache/libdnf5

mkdir -p /opt/actions-runner
cd /opt/actions-runner
curl -fsSL --retry 3 -o runner.tgz \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${arch}-${RUNNER_VERSION}.tar.gz"
echo "${sha}  runner.tgz" | sha256sum -c -
tar xzf runner.tgz
rm runner.tgz

if [ "${WITH_DOCKER:-0}" = 1 ]; then
  mkdir -p /usr/libexec/docker/cli-plugins
  curl -fsSL --retry 3 -o /usr/libexec/docker/cli-plugins/docker-compose \
    "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${compose_arch}"
  chmod 0755 /usr/libexec/docker/cli-plugins/docker-compose
fi

if [ "${WITH_AWSCLI:-0}" = 1 ]; then
  curl -fsSL --retry 3 -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip"
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
  rm -rf /tmp/aws /tmp/awscliv2.zip
fi

echo "installed actions-runner ${RUNNER_VERSION} (${arch})"
