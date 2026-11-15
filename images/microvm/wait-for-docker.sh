#!/bin/bash
# Runner job-started hook: hold the job's first step until dockerd answers, so a docker step
# never races the daemon the agent starts in the background. Gives up quietly after 60 s.
for _ in $(seq 1 120); do
  docker info >/dev/null 2>&1 && exit 0
  sleep 0.5
done
echo "runway: dockerd is not ready after 60 s; docker steps may fail (see /var/log/dockerd.log)"
exit 0
