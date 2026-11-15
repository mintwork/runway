#!/usr/bin/env python3
"""runway agent: runs exactly one GitHub Actions job, on any runway compute type.

Modes:
  serve    Lambda MicroVM image entrypoint. A lifecycle-hook HTTP server; Lambda calls
           /ready at image build (the snapshot point), then /run with the job's runner
           config when a MicroVM launches. Nothing job-specific exists before /run, so
           every MicroVM resumed from the shared snapshot is a clean, unregistered machine.
  oneshot  EC2 and Fargate. Reads RUNWAY_JIT_CONFIG, runs the job, exits.
  lambda   Lambda function handler (lambda_handler). Runs the job, then ends the process
           so Lambda throws the execution environment away instead of reusing it.

Standard library only, and Python 3.9 compatible (Amazon Linux 2023 ships 3.9).
"""

import json
import os
import shutil
import signal
import subprocess  # nosec B404 - the agent exists to run the runner and the container tools
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1/"
JOB_STARTED_MARKERS = ("Running job:",)
DOCKER_DNS = "169.254.169.253"  # Amazon-provided resolver; MicroVMs block outbound UDP to public DNS.


def log(message, **fields):
    entry = {"msg": message}
    entry.update(fields)
    print("runway: " + json.dumps(entry, default=str), flush=True)


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


class Job:
    """One runner process for one job, with an idle watchdog and a hard time limit."""

    def __init__(self, runner_dir, jit_config, run_as=None, max_seconds=21600, idle_seconds=900, popen=subprocess.Popen, clock=time.monotonic):
        self.runner_dir = runner_dir
        self.jit_config = jit_config
        self.run_as = run_as
        self.max_seconds = max_seconds
        self.idle_seconds = idle_seconds
        self.popen = popen
        self.clock = clock
        self.started_job = threading.Event()
        self.proc = None
        self.stop_reason = None

    def command(self):
        return [os.path.join(self.runner_dir, "run.sh"), "--jitconfig", self.jit_config]

    def environment(self):
        env = dict(os.environ)
        # Never leak the agent's own settings (including the JIT config) into job steps.
        for key in list(env):
            if key.startswith("RUNWAY_") or key.startswith("AWS_LAMBDA_"):
                env.pop(key)
        env["RUNNER_ALLOW_RUNASROOT"] = "1"
        if self.run_as:
            env["HOME"] = "/home/" + self.run_as
            env["USER"] = self.run_as
        return env

    def run(self):
        kwargs = {"cwd": self.runner_dir, "env": self.environment(), "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT}
        if self.run_as:
            kwargs["user"] = self.run_as
            kwargs["group"] = self.run_as
            kwargs["extra_groups"] = ["docker"] if _group_exists("docker") else []
        start = self.clock()
        self.proc = self.popen(self.command(), **kwargs)
        log("runner started", pid=self.proc.pid)
        watchdog = threading.Thread(target=self._watch, args=(start,), daemon=True)
        watchdog.start()
        for raw in iter(self.proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            print(line, flush=True)
            if any(marker in line for marker in JOB_STARTED_MARKERS):
                self.started_job.set()
        code = self.proc.wait()
        log("runner exited", code=code, reason=self.stop_reason)
        return code

    def _watch(self, start):
        while self.proc and self.proc.poll() is None:
            elapsed = self.clock() - start
            if not self.started_job.is_set() and elapsed > self.idle_seconds:
                self.stop("no job was assigned within %ds" % self.idle_seconds)
                return
            if elapsed > self.max_seconds:
                self.stop("job time limit of %ds reached" % self.max_seconds)
                return
            time.sleep(1)

    def stop(self, reason):
        self.stop_reason = reason
        log("stopping runner", reason=reason)
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def _group_exists(name):
    try:
        import grp

        grp.getgrnam(name)
        return True
    except (KeyError, ImportError):
        return False


CONTAINERD_SOCKET = "/run/containerd/containerd.sock"


def _relay(proc, name):
    for raw in iter(proc.stdout.readline, b""):
        print(name + ": " + raw.decode("utf-8", "replace").rstrip(), flush=True)


def _wait_for(check, timeout, interval=0.5, clock=time.monotonic):
    deadline = clock() + timeout
    while clock() < deadline:
        if check():
            return True
        time.sleep(interval)
    return False


def _quiet(cmd):
    # cmd is a fixed argument list built in this file, never a shell string.
    return subprocess.call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0  # nosec B603 # nosemgrep


def start_docker(storage=None, containerd_timeout=120, popen=subprocess.Popen):
    """Start containerd, then dockerd on top of it, for this job (MicroVM images, no systemd).

    Started at /run rather than baked into the snapshot: a daemon resumed from a snapshot has
    stale bridge networking. containerd is started separately because right after a MicroVM
    resumes, binaries page in slowly, and dockerd's own wait for the containerd it spawns can
    time out. Output goes to the agent's log (CloudWatch); if dockerd fails, it is retried
    once with the vfs storage driver. Returns the dockerd process, or None without Docker.
    """
    if not shutil.which("dockerd"):
        return None
    storage = storage or os.environ.get("RUNWAY_DOCKER_STORAGE", "overlay2")
    containerd = None
    if shutil.which("containerd"):
        if not _quiet(["ctr", "--address", CONTAINERD_SOCKET, "version"]):
            log("starting containerd")
            containerd = popen(["containerd"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            threading.Thread(target=_relay, args=(containerd, "containerd"), daemon=True).start()
            if not _wait_for(lambda: _quiet(["ctr", "--address", CONTAINERD_SOCKET, "version"]), containerd_timeout):
                log("containerd did not start", seconds=containerd_timeout)
                return None
    args = ["dockerd", "--dns", DOCKER_DNS, "--storage-driver", storage]
    if containerd is not None or os.path.exists(CONTAINERD_SOCKET):
        args += ["--containerd", CONTAINERD_SOCKET]
    log("starting dockerd", storage=storage)
    proc = popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def watch():
        _relay(proc, "dockerd")
        code = proc.wait()
        log("dockerd exited", code=code, storage=storage)
        if code != 0 and storage != "vfs":
            start_docker("vfs", containerd_timeout, popen)

    threading.Thread(target=watch, daemon=True).start()
    return proc


def warm_docker():
    """For the /validate hook: start Docker once so Lambda learns which snapshot pages to prefetch."""
    proc = start_docker()
    if proc is None:
        return
    ready = _wait_for(lambda: _quiet(["docker", "info"]), 180)
    log("docker warm-up", ready=ready)
    proc.terminate()
    _quiet(["pkill", "containerd"])


def parse_run_payload(body):
    """/run delivers {"microvmId": ..., "runHookPayload": "<our JSON string>"}.

    The payload carries either the JIT config itself or (since runHookPayload is capped at
    4096 bytes) a short-lived presigned S3 URL to fetch it from.
    """
    inner = body.get("runHookPayload")
    payload = {}
    if isinstance(inner, str) and inner.strip():
        payload = json.loads(inner)
    elif isinstance(inner, dict):
        payload = dict(inner)
    if not payload.get("jitConfig") and not payload.get("jitUrl", "").startswith("https://"):
        raise ValueError("run payload has neither a jitConfig nor an https jitUrl")
    payload["microvmId"] = body.get("microvmId")
    return payload


def fetch_jit_config(url, opener=None, attempts=5):
    """Download the JIT config from its presigned URL, retrying transient network errors."""
    import urllib.request

    opener = opener or urllib.request.urlopen
    last = None
    for attempt in range(attempts):
        try:
            with opener(url, timeout=10) as res:
                return json.loads(res.read())["jitConfig"]
        except Exception as e:  # noqa: BLE001 - any failure is worth one more try
            last = e
            time.sleep(min(2 ** attempt, 8))
    raise RuntimeError("could not download the JIT config: %s" % last)


class HookServer(BaseHTTPRequestHandler):
    runner_dir = "/opt/actions-runner"
    job = None
    warmup = None
    lock = threading.Lock()

    def log_message(self, format, *args):  # pylint: disable=redefined-builtin  # keep stdout for structured logs
        pass

    def _reply(self, status):
        self.send_response(status)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_GET(self):
        self._reply(200 if self.path == "/health" else 404)

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        path = self.path.split("?", 1)[0]
        if not path.startswith(HOOK_PREFIX):
            return self._reply(404)
        hook = path[len(HOOK_PREFIX):].strip("/")
        log("hook", hook=hook)
        if hook == "ready":
            ready = os.path.exists(os.path.join(self.runner_dir, "bin", "Runner.Listener"))
            return self._reply(200 if ready else 503)
        if hook == "validate":
            # Lambda calls this on a fresh MicroVM from the new image; 503 means "not done yet".
            if os.environ.get("RUNWAY_DOCKER") == "1":
                with HookServer.lock:
                    if HookServer.warmup is None:
                        HookServer.warmup = threading.Thread(target=warm_docker, daemon=True)
                        HookServer.warmup.start()
                if HookServer.warmup.is_alive():
                    return self._reply(503)
            return self._reply(200)
        if hook in ("resume", "suspend"):
            return self._reply(200)
        if hook == "run":
            try:
                payload = parse_run_payload(json.loads(raw or b"{}"))
            except (ValueError, json.JSONDecodeError) as e:
                log("bad run payload", error=str(e))
                return self._reply(400)
            with HookServer.lock:
                if HookServer.job is not None:
                    return self._reply(409)
                HookServer.job = Job(self.runner_dir, payload.get("jitConfig", ""), max_seconds=env_int("RUNWAY_MAX_SECONDS", 28800), idle_seconds=env_int("RUNWAY_IDLE_SECONDS", 900))
            threading.Thread(target=self._run_job, args=(payload,), daemon=True).start()
            return self._reply(200)  # the /run hook has a short budget; the job runs in the background
        if hook == "terminate":
            if HookServer.job:
                HookServer.job.stop("MicroVM terminating")
            return self._reply(200)
        return self._reply(404)

    @staticmethod
    def _run_job(payload):
        log("job starting", runner=payload.get("runnerName"), microvm=payload.get("microvmId"))
        if os.environ.get("RUNWAY_DOCKER") == "1":
            start_docker()
        if not HookServer.job.jit_config:
            try:
                HookServer.job.jit_config = fetch_jit_config(payload["jitUrl"])
            except RuntimeError as e:
                log("job failed before it started", error=str(e))
                return
        code = HookServer.job.run()
        # The dispatcher terminates this MicroVM when GitHub reports the job completed.
        log("job finished; waiting for the MicroVM to be terminated", code=code)


def serve():
    port = env_int("RUNWAY_HOOK_PORT", 9000)
    # Lambda MicroVMs call the hooks over the VM's network interface, so loopback isn't enough.
    server = ThreadingHTTPServer(("0.0.0.0", port), HookServer)  # nosec B104
    log("hook server listening", port=port)
    server.serve_forever()


def oneshot():
    jit = os.environ.get("RUNWAY_JIT_CONFIG")
    if not jit:
        log("RUNWAY_JIT_CONFIG is not set")
        return 2
    job = Job(
        os.environ.get("RUNWAY_RUNNER_DIR", "/opt/actions-runner"),
        jit,
        run_as=os.environ.get("RUNWAY_RUN_AS") or None,
        max_seconds=env_int("RUNWAY_MAX_SECONDS", 21600),
        idle_seconds=env_int("RUNWAY_IDLE_SECONDS", 900),
    )
    signal.signal(signal.SIGTERM, lambda *_: job.stop("received SIGTERM"))
    return job.run()


def prepare_lambda_runner(source="/opt/actions-runner", target="/tmp/actions-runner"):  # nosec B108 - /tmp is Lambda's only writable path
    """The Lambda filesystem is read-only outside /tmp, and the runner writes next to itself."""
    if not os.path.exists(os.path.join(target, "run.sh")):
        started = time.monotonic()
        shutil.copytree(source, target, symlinks=True)
        log("copied runner to /tmp", seconds=round(time.monotonic() - started, 1))
    return target


def lambda_handler(event, context):
    jit = (event or {}).get("jitConfig")
    if not jit:
        log("invocation has no jitConfig")
        return {"ok": False}
    os.environ.setdefault("HOME", "/tmp")  # nosec B108 - /tmp is Lambda's only writable path
    runner_dir = prepare_lambda_runner()
    remaining = int(context.get_remaining_time_in_millis() / 1000) - 20 if context else 880
    job = Job(runner_dir, jit, max_seconds=max(60, remaining), idle_seconds=min(env_int("RUNWAY_IDLE_SECONDS", 300), max(60, remaining)))
    code = job.run()
    log("job finished; discarding this execution environment", code=code)
    sys.stdout.flush()
    # Ending the process makes Lambda discard this sandbox, so no later job can reuse it.
    os._exit(0 if code == 0 else 1)


def main(argv):
    mode = argv[1] if len(argv) > 1 else "serve"
    if mode == "serve":
        serve()
        return 0
    if mode == "oneshot":
        return oneshot()
    print("usage: runway_agent.py [serve|oneshot]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
