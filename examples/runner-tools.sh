#!/bin/bash
# Example runner-tools.sh for runway: tools every job can use without a setup step.
# Runs as root on Amazon Linux 2023: at image build for MicroVM, Fargate and Lambda runners,
# and at every boot on EC2 (keep it quick there). runway sets:
#   RUNWAY_ARCH    arm64 | x64
#   RUNWAY_TARGET  microvm | fargate | lambda | ec2
# Apply it with: npx @mintwork/runway update --runner-tools ./runner-tools.sh
set -euo pipefail

# Build tools and Python from Amazon Linux packages.
dnf install -y --setopt=install_weak_deps=0 gcc gcc-c++ make python3.12 python3.12-pip

# Node.js LTS, from nodejs.org, for the right architecture.
NODE_VERSION=26.13.1
case "$RUNWAY_ARCH" in arm64) node_arch=arm64 ;; x64) node_arch=x64 ;; esac
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1

# Heavier tools only where they make sense: skip them on Lambda (15-minute jobs) and EC2 (boot time).
if [ "$RUNWAY_TARGET" != lambda ] && [ "$RUNWAY_TARGET" != ec2 ]; then
  dnf install -y --setopt=install_weak_deps=0 java-21-amazon-corretto-devel

  TERRAFORM_VERSION=1.17.2
  case "$RUNWAY_ARCH" in arm64) tf_arch=arm64 ;; x64) tf_arch=amd64 ;; esac
  curl -fsSL -o /tmp/terraform.zip \
    "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${tf_arch}.zip"
  unzip -o -q /tmp/terraform.zip -d /usr/local/bin
  rm /tmp/terraform.zip
fi

dnf clean all
