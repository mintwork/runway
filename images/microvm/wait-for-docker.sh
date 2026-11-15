#!/bin/bash
# Runner job-started hook: hold the job's first step until dockerd answers, so a docker step
# never races the daemon the agent starts in the background. Gives up quietly after 180 s.
for _ in $(seq 1 360); do
  docker info >/dev/null 2>&1 && exit 0
  sleep 0.5
done
echo "runway: dockerd is not ready after 180 s; docker steps may fail (dockerd output is in the MicroVM log in CloudWatch)"
exit 0
