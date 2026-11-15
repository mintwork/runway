import io
import json
import os
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import runway_agent as agent


class FakeProc:
    """A runner process that prints the given lines, then waits until it is terminated or finishes."""

    def __init__(self, lines, exit_code=0, block=False):
        self.stdout = io.BytesIO("".join(line + "\n" for line in lines).encode())
        self.pid = 4242
        self._code = None
        self._exit_code = exit_code
        self._block = block
        self._done = threading.Event()
        if not block:
            self._done.set()
        self.terminated = False

    def poll(self):
        return self._code if self._done.is_set() else None

    def wait(self, timeout=None):
        self._done.wait(timeout)
        if self._code is None:
            self._code = -15 if self.terminated else self._exit_code
        return self._code

    def terminate(self):
        self.terminated = True
        self._done.set()

    def kill(self):
        self.terminate()


class BlockingStdout(io.BytesIO):
    """stdout that yields lines, then blocks (like a live process) until the process ends."""

    def __init__(self, lines, proc):
        super().__init__("".join(line + "\n" for line in lines).encode())
        self.proc = proc

    def readline(self, *args):
        line = super().readline(*args)
        if line:
            return line
        self.proc._done.wait(5)
        return b""


class JobTest(unittest.TestCase):
    def make_job(self, proc, **kwargs):
        calls = []

        def popen(cmd, **kw):
            calls.append((cmd, kw))
            return proc

        job = agent.Job("/opt/actions-runner", "JITBLOB", popen=popen, **kwargs)
        return job, calls

    def test_runs_run_sh_with_the_jit_config_and_returns_its_exit_code(self):
        job, calls = self.make_job(FakeProc(["Connected to GitHub", "Running job: build"], exit_code=3))
        self.assertEqual(job.run(), 3)
        cmd, kw = calls[0]
        self.assertEqual(cmd, ["/opt/actions-runner/run.sh", "--jitconfig", "JITBLOB"])
        self.assertEqual(kw["cwd"], "/opt/actions-runner")
        self.assertTrue(job.started_job.is_set())

    def test_does_not_leak_agent_settings_into_job_steps(self):
        with mock.patch.dict(os.environ, {"RUNWAY_JIT_CONFIG": "secret", "AWS_LAMBDA_RUNTIME_API": "x", "PATH": "/usr/bin"}):
            env = agent.Job("/r", "J").environment()
        self.assertNotIn("RUNWAY_JIT_CONFIG", env)
        self.assertNotIn("AWS_LAMBDA_RUNTIME_API", env)
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertEqual(env["RUNNER_ALLOW_RUNASROOT"], "1")

    def test_runs_as_an_unprivileged_user_when_asked(self):
        job, calls = self.make_job(FakeProc([]), run_as="runner")
        with mock.patch.object(agent, "_group_exists", return_value=True):
            job.run()
        kw = calls[0][1]
        self.assertEqual((kw["user"], kw["group"], kw["extra_groups"]), ("runner", "runner", ["docker"]))
        self.assertEqual(kw["env"]["HOME"], "/home/runner")

    def _run_with_clock(self, lines, clock_values, **kwargs):
        proc = FakeProc([], block=True)
        proc.stdout = BlockingStdout(lines, proc)
        ticks = iter(clock_values)
        last = [0]

        def clock():
            last[0] = next(ticks, last[0])
            return last[0]

        job, _ = self.make_job(proc, clock=clock, **kwargs)
        with mock.patch.object(agent.time, "sleep", lambda s: None):
            code = job.run()
        return job, proc, code

    def test_stops_a_runner_that_never_gets_a_job(self):
        job, proc, code = self._run_with_clock([], [0, 0, 500, 1000], idle_seconds=900)
        self.assertTrue(proc.terminated)
        self.assertIn("no job was assigned", job.stop_reason)
        self.assertEqual(code, -15)

    def test_keeps_a_busy_runner_past_the_idle_limit_but_not_past_the_time_limit(self):
        proc = FakeProc([], block=True)
        proc.stdout = BlockingStdout(["Running job: test"], proc)
        ticks = iter([0, 1000, 5000, 9000])
        holder = {}

        def clock():
            # Don't let time pass the idle limit until the runner has reported its job.
            if "job" in holder:
                holder["job"].started_job.wait(2)
            return next(ticks, 9000)

        job, _ = self.make_job(proc, clock=clock, idle_seconds=900, max_seconds=8000)
        holder["job"] = job
        with mock.patch.object(agent.time, "sleep", lambda s: None):
            job.run()
        self.assertTrue(proc.terminated)
        self.assertIn("time limit", job.stop_reason)


class PayloadTest(unittest.TestCase):
    def test_unwraps_the_run_hook_payload(self):
        body = {"microvmId": "vm-1", "runHookPayload": json.dumps({"runnerName": "runway-a", "jitConfig": "J"})}
        self.assertEqual(agent.parse_run_payload(body), {"runnerName": "runway-a", "jitConfig": "J", "microvmId": "vm-1"})

    def test_rejects_a_payload_without_a_jit_config(self):
        with self.assertRaises(ValueError):
            agent.parse_run_payload({"runHookPayload": json.dumps({"runnerName": "x"})})


class HookServerTest(unittest.TestCase):
    def setUp(self):
        agent.HookServer.job = None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), agent.HookServer)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        agent.HookServer.job = None

    def post(self, hook, body=None):
        req = urllib.request.Request(self.base + agent.HOOK_PREFIX + hook, data=json.dumps(body or {}).encode(), method="POST")
        try:
            return urllib.request.urlopen(req).status
        except urllib.error.HTTPError as e:
            return e.code

    def test_ready_waits_for_the_runner_binaries(self):
        with mock.patch.object(agent.os.path, "exists", return_value=False):
            self.assertEqual(self.post("ready"), 503)
        with mock.patch.object(agent.os.path, "exists", return_value=True):
            self.assertEqual(self.post("ready"), 200)

    def test_run_starts_one_job_and_refuses_a_second(self):
        started = threading.Event()
        with mock.patch.object(agent.HookServer, "_run_job", staticmethod(lambda payload: started.set())):
            body = {"microvmId": "vm-1", "runHookPayload": json.dumps({"jitConfig": "J"})}
            self.assertEqual(self.post("run", body), 200)
            self.assertTrue(started.wait(2))
            self.assertEqual(self.post("run", body), 409)

    def test_bad_payloads_and_unknown_hooks(self):
        self.assertEqual(self.post("run", {"runHookPayload": "{}"}), 400)
        self.assertEqual(self.post("nope"), 404)
        self.assertEqual(self.post("validate"), 200)


class LambdaTest(unittest.TestCase):
    def test_runs_the_job_then_discards_the_environment(self):
        ctx = mock.Mock()
        ctx.get_remaining_time_in_millis.return_value = 900_000
        with mock.patch.object(agent, "prepare_lambda_runner", return_value="/tmp/actions-runner"), \
                mock.patch.object(agent.Job, "run", return_value=0) as run, \
                mock.patch.object(agent.os, "_exit") as exit_:
            agent.lambda_handler({"jitConfig": "J", "runnerName": "runway-a"}, ctx)
        run.assert_called_once()
        exit_.assert_called_once_with(0)

    def test_ignores_an_invocation_without_a_jit_config(self):
        self.assertEqual(agent.lambda_handler({}, None), {"ok": False})


class OneshotTest(unittest.TestCase):
    def test_needs_a_jit_config(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(agent.oneshot(), 2)


if __name__ == "__main__":
    unittest.main()
