# Adding your own tools to the runners

runway's runner images are lean on purpose: Amazon Linux 2023 with git, the AWS CLI, Python 3,
the GitHub Actions runner, and Docker on MicroVMs and EC2. They are not GitHub's `ubuntu-latest`
images, which ship hundreds of tools. You have two ways to add what your jobs need.

## Option 1: per job, with setup actions (no runway changes)

The same actions you'd use in a container job work on every runway compute type:

```yaml
jobs:
  test:
    runs-on: [runway, microvm]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - uses: actions/setup-python@v7
        with: { python-version: "3.14" }
      - run: npm ci && npm test
```

Best when different repositories need different versions. It costs a few seconds per job (cached
downloads help).

## Option 2: once for every job, with `runner-tools.sh`

Write a script that installs your tools and hand it to runway. It's baked into the MicroVM, Fargate
and Lambda images when they're built, and EC2 runners run it at boot.

```bash
npx -y @mintwork/runway update --runner-tools ./runner-tools.sh    # upload and rebuild the images
npx -y @mintwork/runway update --runner-tools none                 # remove it again
```

The rebuild takes 10–20 minutes. Jobs keep running on the old images until the new ones are ready.
The weekly image refresh keeps using your script, so you set it once.

### What your script gets

- It runs **as root** on **Amazon Linux 2023**: install packages with `dnf install -y`.
- It runs with `bash -euo pipefail`, so a failing command fails the build (and `runway update`
  tells you; the logs are in CloudWatch, under `/runway/<stack>/microvm` and `/runway/<stack>/codebuild`).
- It must be **non-interactive** and work on **both architectures**. runway tells it where it's running:

| Variable        | Values                                |
| --------------- | ------------------------------------- |
| `RUNWAY_ARCH`   | `arm64`, `x64`                        |
| `RUNWAY_TARGET` | `microvm`, `fargate`, `lambda`, `ec2` |

Use them to download the right binaries and to skip work where it doesn't belong.

### Example

[`examples/runner-tools.sh`](../examples/runner-tools.sh) installs build tools, Python 3.12 and
Node.js LTS everywhere, plus Java and Terraform except on Lambda and EC2. It's tested on both
architectures:

```bash
#!/bin/bash
set -euo pipefail

# Build tools, Python, and libatomic (the Node.js binaries need it) from Amazon Linux packages.
dnf install -y --setopt=install_weak_deps=0 gcc gcc-c++ make python3.12 python3.12-pip libatomic

# Node.js LTS, from nodejs.org, for the right architecture.
NODE_VERSION=26.13.1
case "$RUNWAY_ARCH" in arm64) node_arch=arm64 ;; x64) node_arch=x64 ;; esac
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1

# Heavier tools only where they make sense.
if [ "$RUNWAY_TARGET" != lambda ] && [ "$RUNWAY_TARGET" != ec2 ]; then
  dnf install -y --setopt=install_weak_deps=0 java-21-amazon-corretto-devel
  TERRAFORM_VERSION=1.17.2
  case "$RUNWAY_ARCH" in arm64) tf_arch=arm64 ;; x64) tf_arch=amd64 ;; esac
  curl -fsSL -o /tmp/terraform.zip \
    "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${tf_arch}.zip"
  unzip -o -q /tmp/terraform.zip -d /usr/local/bin && rm /tmp/terraform.zip
fi

dnf clean all
```

Try a script before you ship it, in the same base OS:

```bash
docker run --rm -v "$PWD:/x" -e RUNWAY_ARCH=arm64 -e RUNWAY_TARGET=microvm \
  public.ecr.aws/amazonlinux/amazonlinux:2023 bash -euo pipefail /x/runner-tools.sh
```

### Things to keep in mind

- **Disk.** A 1cpu MicroVM has 8 GB of disk, shared by the image and your job. Big toolchains
  belong on 2cpu (16 GB) or 4cpu (32 GB) MicroVMs, EC2 or Fargate.
- **EC2 runs the script at every boot**, before the job starts, so each package adds to the
  start time. Skip slow installs there (`RUNWAY_TARGET=ec2`) or use setup actions.
- **Lambda** runs jobs as a non-root user with a read-only filesystem outside `/tmp`. Tools
  installed by the script work; jobs can't install more with `dnf`.
- **Pin versions** (like `NODE_VERSION` above) so images are reproducible, and bump them on purpose.
- **Secrets don't belong in the script.** It's stored in your stack's data bucket and baked into
  images. Give jobs credentials at run time (GitHub secrets, or `--runner-policy` for AWS).

### With the AWS CLI instead

`runway update --runner-tools` does two things you can also do by hand: upload the script to the
stack's data bucket (its `DataBucket` output) and start an image rebuild:

```bash
aws s3 cp runner-tools.sh s3://<DataBucket>/runway/custom/runner-tools.sh
aws lambda invoke --function-name runway-<stack>-maintainer --payload '{"force":true}' \
  --cli-binary-format raw-in-base64-out /dev/stdout
```

To remove it, delete the object and run the same `aws lambda invoke`.
