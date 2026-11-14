"""depot-core against the real pinned tool cores.

Each test drives the server through its message protocol, so these also
catch an upstream change in a tool that would break Depot.
Run from the repository root:  python -m unittest discover -s core/tests
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CORE))

from depot_core.server import build_server  # noqa: E402


class Harness:
    """Calls methods synchronously and collects every message the core sends."""

    def __init__(self):
        self.out = io.StringIO()
        self.server = build_server(self.out)
        self._read = 0

    def messages(self):
        lines = self.out.getvalue().splitlines()[self._read :]
        self._read += len(lines)
        return [json.loads(line) for line in lines]

    def call(self, method, params=None):
        self.server._dispatch(1, method, params or {})
        msgs = self.messages()
        reply = next(m for m in msgs if "id" in m)
        events = [(m["event"], m["payload"]) for m in msgs if "event" in m]
        streams = [(m["stream"], m["params"]) for m in msgs if "stream" in m]
        return reply, events, streams


class ProtocolTests(unittest.TestCase):
    def test_ping_lists_versions(self):
        reply, _, _ = Harness().call("core.ping")
        self.assertIn("needle", reply["result"]["tools"])

    def test_unknown_method_and_bad_params_are_errors_not_crashes(self):
        h = Harness()
        reply, _, _ = h.call("nope.nothing")
        self.assertEqual(reply["error"]["kind"], "unknown_method")
        reply, _, _ = h.call("needle.search", {"index_path": "relative/path.json"})
        self.assertEqual(reply["error"]["kind"], "invalid")

    def test_handle_line_rejects_garbage(self):
        h = Harness()
        h.server.handle_line("not json")
        self.assertEqual(h.messages()[0]["error"]["kind"], "invalid")

    def test_every_published_event_is_in_the_catalogue(self):
        catalogue = json.loads((CORE.parent / "src" / "protocol" / "events.json").read_text(encoding="utf-8"))
        source = "\n".join(p.read_text(encoding="utf-8") for p in (CORE / "depot_core" / "tools").glob("*.py"))
        import re

        used = set(re.findall(r'ctx\.event\(\s*"([a-z_]+\.[a-z_]+)"', source))
        self.assertTrue(used)
        self.assertEqual(used - set(catalogue["events"]), set())


class NeedleTests(unittest.TestCase):
    def test_build_then_search_publishes_events(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "proj"
            root.mkdir()
            (root / "notes.md").write_text("depot connects local tools", encoding="utf-8")
            index = Path(d) / "index.json"
            h = Harness()
            reply, events, _ = h.call("needle.build_index", {"roots": [str(root)], "index_path": str(index)})
            self.assertEqual(reply["result"]["documents"], 1)
            self.assertEqual([e for e, _ in events], ["needle.index_started", "needle.index_complete"])
            self.assertFalse(events[0][1]["incremental"])

            reply, events, _ = h.call("needle.search", {"index_path": str(index), "query": "connects"})
            self.assertEqual(reply["result"]["results"][0]["name"], "notes.md")
            self.assertEqual(events[0][0], "needle.search_complete")

            reply, events, _ = h.call("needle.build_index", {"roots": [str(root)], "index_path": str(index)})
            self.assertTrue(events[0][1]["incremental"])

    def test_search_without_index_says_build_first(self):
        with tempfile.TemporaryDirectory() as d:
            reply, _, _ = Harness().call("needle.search", {"index_path": str(Path(d) / "none.json"), "query": "x"})
            self.assertEqual(reply["error"]["kind"], "not_found")


class _Echo(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = b'{"ok": true}'
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class RelayTests(unittest.TestCase):
    def test_send_records_history_and_strips_query_from_events(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Echo)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as d:
                h = Harness()
                url = f"http://127.0.0.1:{httpd.server_address[1]}/x?token=secret"
                reply, events, _ = h.call("relay.send", {"store_dir": d, "request": {"method": "get", "url": url}})
                self.assertEqual(reply["result"]["response"]["status"], 201)
                kinds = dict(events)
                self.assertNotIn("secret", kinds["relay.request_sent"]["url"])
                self.assertEqual(kinds["relay.response_received"]["status"], 201)
                history, _, _ = h.call("relay.history", {"store_dir": d})
                self.assertEqual(len(history["result"]), 1)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_connection_failure_is_a_result_not_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            reply, events, _ = Harness().call(
                "relay.send", {"store_dir": d, "request": {"method": "GET", "url": "http://127.0.0.1:1/"}}
            )
            self.assertFalse(reply["result"]["ok"])
            self.assertEqual(events[-1][0], "relay.request_failed")


class PulseTests(unittest.TestCase):
    def test_new_and_closed_ports_after_the_baseline(self):
        from depot_core.tools import pulse
        from pulse.models import ConnectionInfo, ProcessInfo

        def procs(*ports):
            return lambda: [
                ProcessInfo(10, 1, "node", connections=[ConnectionInfo(10, f"127.0.0.1:{port}", "0.0.0.0:0", "LISTEN", "tcp") for port in ports]),
                ProcessInfo(11, 1, "ssh", connections=[ConnectionInfo(11, "10.0.0.2:5555", "1.2.3.4:22", "ESTAB", "tcp")]),
            ]

        h = Harness()
        ctx = h.server.context

        result = pulse.snapshot({}, ctx, collect=procs(3000))
        self.assertEqual(result["listening"][0]["port"], 3000)
        first = [m["event"] for m in h.messages() if "event" in m]
        self.assertEqual(first, ["pulse.snapshot"])  # baseline: no flood of "new" ports

        pulse.snapshot({}, ctx, collect=procs(3000, 5173))
        events = [(m["event"], m["payload"]) for m in h.messages() if "event" in m]
        self.assertEqual(events[0], ("pulse.port_listening", {"pid": 10, "process_name": "node", "address": "127.0.0.1", "port": 5173, "protocol": "tcp"}))

        pulse.snapshot({}, ctx, collect=procs(5173))
        events = [(m["event"], m["payload"]) for m in h.messages() if "event" in m]
        self.assertEqual(events[0], ("pulse.port_closed", {"pid": 10, "port": 3000}))

    def test_port_parsing(self):
        from depot_core.tools.pulse import _port

        self.assertEqual(_port("[::]:22"), 22)
        self.assertEqual(_port("*:68"), 68)
        self.assertIsNone(_port("garbage"))

    def test_real_snapshot_runs_on_this_machine(self):
        reply, events, _ = Harness().call("pulse.snapshot")
        self.assertGreater(len(reply["result"]["processes"]), 0)
        self.assertEqual(events[-1][0], "pulse.snapshot")


class BlackboxTests(unittest.TestCase):
    def test_scan_writes_report_and_counts_findings(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d) / "repo"
            repo.mkdir()
            (repo / "app.py").write_text("# TODO: tidy\nimport os\n", encoding="utf-8")
            report = Path(d) / "out" / "last-report.json"
            h = Harness()
            reply, events, _ = h.call("blackbox.scan", {"root": str(repo), "report_path": str(report)})
            result = reply["result"]
            self.assertEqual(result["by_severity"]["info"], 1)
            self.assertTrue(all(f["source"] == "blackbox" for f in result["findings"]))
            self.assertEqual([e for e, _ in events], ["blackbox.scan_started", "blackbox.scan_complete"])
            again, _, _ = h.call("blackbox.last_report", {"report_path": str(report)})
            self.assertEqual(again["result"]["summary"], result["summary"])


class ForgeTests(unittest.TestCase):
    def test_failed_command_reports_pid_and_streams_log(self):
        with tempfile.TemporaryDirectory() as d:
            h = Harness()
            workflow = {"name": "t", "steps": [{"type": "command", "config": {"command": f'"{sys.executable}" -c "import sys; print(1); sys.exit(4)"'}}]}
            reply, events, streams = h.call("forge.run", {"run_id": "r1", "workflow_id": "w1", "workflow": workflow})
            self.assertEqual(reply["result"]["outcome"], "failed")
            kinds = [e for e, _ in events]
            self.assertEqual(kinds, ["forge.run_started", "forge.step_started", "forge.step_failed", "forge.run_finished"])
            failed = dict(events)["forge.step_failed"]
            self.assertIsInstance(failed["pid"], int)
            self.assertEqual(failed["exit_code"], 4)
            self.assertTrue(any(s == "forge.log" for s, _ in streams))

            saved, _, _ = h.call("forge.save", {"store_dir": d, "workflows": [workflow]})
            self.assertEqual(saved["result"]["saved"], 1)
            listed, _, _ = h.call("forge.list", {"store_dir": d})
            self.assertEqual(listed["result"][0]["name"], "t")

    def test_unknown_step_type_is_invalid(self):
        reply, _, _ = Harness().call("forge.run", {"run_id": "r", "workflow_id": "w", "workflow": {"name": "t", "steps": [{"type": "launch-missiles"}]}})
        self.assertEqual(reply["error"]["kind"], "invalid")


class SwitchyardTests(unittest.TestCase):
    def test_session_lifecycle_maps_to_bus_events(self):
        import switchyard_core as sy

        with tempfile.TemporaryDirectory() as d:
            state_path = Path(d) / "state.json"
            runtime_path = Path(d) / "runtime.json"
            project = sy.new_project(d, "demo")
            service = sy.new_service(project, "sleeper", f'"{sys.executable}" -c "import time; time.sleep(30)"')
            session = sy.new_session("dev", [service.id])
            sy.save_state(sy.WorkspaceState(projects=[project], services=[service], sessions=[session]), state_path)
            paths = {"state_path": str(state_path), "runtime_path": str(runtime_path)}

            h = Harness()
            reply, _, _ = h.call("switchyard.state", paths)
            self.assertEqual(reply["result"]["sessions"][0]["name"], "dev")

            reply, _, _ = h.call("switchyard.start_session", {**paths, "session_id": session.id})
            self.assertTrue(reply["result"]["started"], reply)
            deadline = time.time() + 15
            seen: list[str] = []
            while time.time() < deadline and "switchyard.service_ready" not in seen:
                seen += [m["event"] for m in h.messages() if "event" in m]
                time.sleep(0.1)
            self.assertIn("switchyard.session_started", seen)
            self.assertIn("switchyard.service_ready", seen)

            status, _, _ = h.call("switchyard.status")
            self.assertIsInstance(status["result"][0]["services"][0]["pid"], int)

            reply, events, _ = h.call("switchyard.stop_session", {"session_id": session.id})
            time.sleep(0.5)
            later = [m["event"] for m in h.messages() if "event" in m]
            stopped = [e for e, _ in events] + later
            self.assertIn("switchyard.session_stopped", stopped)
            # Stopping on purpose is not a health problem.
            self.assertNotIn("switchyard.service_unhealthy", stopped)


class HostGoneTests(unittest.TestCase):
    def test_send_never_raises_after_the_host_has_gone(self):
        h = Harness()
        closed = io.StringIO()
        closed.close()
        h.server._out = closed
        h.server.send({"event": "x", "payload": {}})  # must not raise
        self.assertTrue(h.server.host_gone)

    def test_services_stop_when_depot_dies_without_warning(self):
        """Depot killed: both pipes close at once. Shutdown must still stop the
        session's services, though every event it publishes on the way fails."""
        import switchyard_core as sy

        with tempfile.TemporaryDirectory() as d:
            state_path = Path(d) / "state.json"
            pidfile = Path(d) / "pid"
            script = Path(d) / "sleeper.py"
            script.write_text(f"import os, time\nopen({str(pidfile)!r}, 'w').write(str(os.getpid()))\ntime.sleep(60)\n", encoding="utf-8")
            project = sy.new_project(d, "demo")
            service = sy.new_service(project, "sleeper", f'"{sys.executable}" "{script}"')
            session = sy.new_session("dev", [service.id])
            sy.save_state(sy.WorkspaceState(projects=[project], services=[service], sessions=[session]), state_path)

            proc = subprocess.Popen(
                [sys.executable, "-m", "depot_core"], cwd=CORE, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True,
            )
            params = {"session_id": session.id, "state_path": str(state_path), "runtime_path": str(Path(d) / "rt.json")}
            proc.stdin.write(json.dumps({"id": 1, "method": "switchyard.start_session", "params": params}) + "\n")
            proc.stdin.flush()
            reply = next(m for m in map(json.loads, iter(proc.stdout.readline, "")) if m.get("id") == 1)
            self.assertTrue(reply["result"]["started"], reply)
            deadline = time.time() + 15
            while not pidfile.exists() and time.time() < deadline:
                time.sleep(0.1)
            pid = int(pidfile.read_text())

            proc.stdout.close()  # the host is gone: nobody reads any more…
            proc.stdin.close()   # …and nobody writes
            proc.wait(timeout=20)
            deadline = time.time() + 10
            while _alive(pid) and time.time() < deadline:
                time.sleep(0.1)
            self.assertFalse(_alive(pid), "the service outlived Depot")


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie is dead for our purposes.
    try:
        return Path(f"/proc/{pid}/status").read_text().find("State:\tZ") == -1
    except OSError:
        return True


class EntryPointTests(unittest.TestCase):
    def test_runs_as_a_process_over_stdio(self):
        proc = subprocess.run(
            [sys.executable, "-m", "depot_core"],
            input='{"id": 1, "method": "core.ping"}\n',
            capture_output=True,
            text=True,
            cwd=CORE,
            timeout=60,
        )
        reply = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(reply["id"], 1)
        self.assertIn("version", reply["result"])


if __name__ == "__main__":
    unittest.main()
