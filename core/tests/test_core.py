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

from depot_core import vendor  # noqa: E402
from depot_core.server import build_server  # noqa: E402

vendor.install()  # tests import the tools directly, whatever order they run in


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

    def call(self, method, params=None, workspace=None):
        self.server._dispatch(1, method, params or {}, workspace)
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


class RelayMoreTests(unittest.TestCase):
    def test_saved_requests_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            h = Harness()
            reply, _, _ = h.call("relay.save", {"store_dir": d, "name": "health", "request": {"method": "get", "url": "http://x/health"}})
            self.assertEqual([r["name"] for r in reply["result"]], ["health"])
            reply, _, _ = h.call("relay.saved", {"store_dir": d})
            self.assertEqual(reply["result"][0]["request"]["method"], "GET")
            reply, _, _ = h.call("relay.delete_saved", {"store_dir": d, "name": "health"})
            self.assertEqual(reply["result"], [])

    def test_mock_server_answers_on_localhost_and_stops(self):
        import urllib.request

        h = Harness()
        reply, events, _ = h.call("relay.mock_start", {"port": 0, "routes": [{"path": "/ping", "status": 201, "body": '{"pong": true}'}]})
        port = reply["result"]["port"]
        self.assertEqual(dict(events)["relay.mock_started"], {"port": port, "routes": ["/ping"]})
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=5) as r:
                self.assertEqual((r.status, r.read()), (201, b'{"pong": true}'))
            listed, _, _ = h.call("relay.mock_list")
            self.assertIn(port, [m["port"] for m in listed["result"]])
        finally:
            reply, events, _ = h.call("relay.mock_stop", {"port": port})
        self.assertEqual(dict(events)["relay.mock_stopped"], {"port": port})
        with self.assertRaises(OSError):
            urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=2)

    def test_mock_rejects_bad_status_and_busy_ports(self):
        h = Harness()
        reply, _, _ = h.call("relay.mock_start", {"port": 0, "routes": [{"path": "/", "status": 999}]})
        self.assertEqual(reply["error"]["kind"], "invalid")
        first, _, _ = h.call("relay.mock_start", {"port": 0, "routes": [{"path": "/"}]})
        port = first["result"]["port"]
        try:
            again, _, _ = h.call("relay.mock_start", {"port": port, "routes": [{"path": "/"}]})
            self.assertEqual(again["error"]["kind"], "invalid")
        finally:
            h.call("relay.mock_stop", {"port": port})

    def test_shutdown_stops_mock_servers(self):
        import urllib.request

        h = Harness()
        port = h.call("relay.mock_start", {"port": 0, "routes": [{"path": "/"}]})[0]["result"]["port"]
        h.call("core.shutdown")
        with self.assertRaises(OSError):
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2)


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
            reply, events, streams = h.call("forge.run", {"run_id": "r1", "workflow_id": "w1", "workflow": workflow, "base_dir": d})
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
        with tempfile.TemporaryDirectory() as d:
            reply, _, _ = Harness().call(
                "forge.run", {"run_id": "r", "workflow_id": "w", "base_dir": d, "workflow": {"name": "t", "steps": [{"type": "launch-missiles"}]}}
            )
        self.assertEqual(reply["error"]["kind"], "invalid")


class ForgeSafetyTests(unittest.TestCase):
    def run_workflow(self, steps, base):
        return Harness().call("forge.run", {"run_id": "r", "workflow_id": "w", "base_dir": str(base), "workflow": {"name": "t", "steps": steps}})

    def test_a_blank_delete_is_refused_before_anything_runs(self):
        with tempfile.TemporaryDirectory() as d:
            keep = Path(d) / "keep.txt"
            keep.write_text("x")
            reply, events, _ = self.run_workflow([{"type": "delete", "config": {"path": "  "}}], d)
            self.assertEqual(reply["error"]["kind"], "invalid")
            self.assertIn("path is empty", reply["error"]["message"])
            self.assertEqual(events, [])  # nothing started
            self.assertTrue(keep.exists())

    def test_commands_and_relative_paths_run_in_the_workspace(self):
        with tempfile.TemporaryDirectory() as d:
            steps = [
                {"type": "command", "config": {"command": f'"{sys.executable}" -c "import os; open(\'where.txt\', \'w\').write(os.getcwd())"'}},
                {"type": "write", "config": {"path": "out/note.txt", "content": "hi"}},
            ]
            reply, _, _ = self.run_workflow(steps, d)
            self.assertEqual(reply["result"]["outcome"], "completed", reply)
            self.assertEqual(Path((Path(d) / "where.txt").read_text()).resolve(), Path(d).resolve())
            self.assertEqual((Path(d) / "out" / "note.txt").read_text(), "hi")

    def test_event_labels_never_carry_the_command_line(self):
        with tempfile.TemporaryDirectory() as d:
            secret = "s3cr3t-value"
            steps = [{"type": "command", "config": {"command": f'"{sys.executable}" -c "import sys; sys.exit(2)" --password {secret}'}}]
            _, events, _ = self.run_workflow(steps, d)
            self.assertNotIn(secret, json.dumps(events))
            self.assertEqual(dict(events)["forge.step_failed"]["label"], "command step 1")


class ForgeFileTests(unittest.TestCase):
    def test_export_then_import_round_trips_in_forges_format(self):
        with tempfile.TemporaryDirectory() as d:
            store = Path(d) / "forge"
            h = Harness()
            wf = {"name": "Ship", "description": "", "steps": [{"type": "mkdir", "config": {"path": "out"}}]}
            h.call("forge.save", {"store_dir": str(store), "workflows": [wf]})
            target = Path(d) / "ship.forge.json"
            reply, _, _ = h.call("forge.export", {"store_dir": str(store), "index": 0, "path": str(target)})
            self.assertEqual(reply["result"]["name"], "Ship")
            from forge.storage import ForgeStore
            self.assertEqual(ForgeStore.import_workflow(target).name, "Ship")  # standalone Forge can read it
            reply, _, _ = h.call("forge.import", {"store_dir": str(store), "path": str(target)})
            self.assertEqual([w["name"] for w in reply["result"]], ["Ship", "Ship"])

    def test_import_rejects_files_that_are_not_workflows(self):
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "bad.json"
            bad.write_text("[1, 2]")
            reply, _, _ = Harness().call("forge.import", {"store_dir": d, "path": str(bad)})
            self.assertEqual(reply["error"]["kind"], "invalid")
            reply, _, _ = Harness().call("forge.import", {"store_dir": d, "path": str(Path(d) / "none.json")})
            self.assertEqual(reply["error"]["kind"], "not_found")


class RedactionTests(unittest.TestCase):
    def test_urls_lose_credentials_and_queries(self):
        from depot_core import redact

        self.assertEqual(redact.url("https://bob:hunter2@api.example.com:8443/v1/x?token=abc#frag"), "https://api.example.com:8443/v1/x")
        self.assertEqual(redact.url("http://[::1]:80/a?b=c"), "http://[::1]:80/a")

    def test_free_text_is_cleaned(self):
        from depot_core import redact

        out = redact.text("failed to reach https://u:pw@h/p?key=1 with password=hunter2 and Authorization: Bearer abc.def")
        for leaked in ("pw@", "key=1", "hunter2", "abc.def"):
            self.assertNotIn(leaked, out)
        self.assertNotIn("tok-123", redact.text("deploy --api-key tok-123 --token=tok-123"))
        self.assertNotIn("abcdefghij", redact.text("sent Bearer abcdefghij"))
        # Ordinary prose is not mangled.
        for prose in ("Session started", "token count is 4", "the secret of good code", "auth failed"):
            self.assertEqual(redact.text(prose), prose)

    def test_relay_events_drop_userinfo_and_secrets_in_errors(self):
        with tempfile.TemporaryDirectory() as d:
            request = {"method": "GET", "url": "http://alice:topsecret@127.0.0.1:1/x?token=abc"}
            _, events, _ = Harness().call("relay.send", {"store_dir": d, "request": request})
            dumped = json.dumps(events)
            for leaked in ("alice", "topsecret", "token=abc"):
                self.assertNotIn(leaked, dumped)


class WorkspaceAttributionTests(unittest.TestCase):
    def test_events_carry_the_workspace_of_the_request_that_caused_them(self):
        h = Harness()
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a.md").write_text("alpha")
            h.server._dispatch(1, "needle.build_index", {"roots": [d], "index_path": str(Path(d) / "i.json")}, "workspace-a")
        events = [m for m in h.messages() if "event" in m]
        self.assertTrue(events)
        self.assertTrue(all(m["workspace"] == "workspace-a" for m in events))


class ShutdownTests(unittest.TestCase):
    def test_nothing_starts_once_shutdown_has_begun(self):
        h = Harness()
        h.server.begin_shutdown()
        with tempfile.TemporaryDirectory() as d:
            marker = Path(d) / "ran"
            reply, _, _ = h.call(
                "forge.run",
                {"run_id": "late", "workflow_id": "w", "base_dir": d, "workflow": {"name": "t", "steps": [{"type": "write", "config": {"path": str(marker)}}]}},
            )
            self.assertEqual(reply["error"]["kind"], "shutting_down")
            self.assertFalse(marker.exists())

    def test_queued_requests_are_dropped_not_run(self):
        """A request still waiting in the queue when shutdown begins never runs."""
        from depot_core.server import Server

        server = Server(io.StringIO(), workers=1)
        gate = threading.Event()
        ran = []
        server.register("test.block", lambda _p, _c: gate.wait(5))
        server.register("test.record", lambda _p, _c: ran.append(1))
        server.handle_line(json.dumps({"id": 1, "method": "test.block"}))
        server.handle_line(json.dumps({"id": 2, "method": "test.record"}))  # queued behind the block
        server.shutting_down = True
        server._pool.shutdown(wait=False, cancel_futures=True)
        gate.set()
        server._pool.shutdown(wait=True)
        self.assertEqual(ran, [])

    def test_core_shutdown_stops_sessions_and_waits_for_them(self):
        import switchyard_core as sy

        with tempfile.TemporaryDirectory() as d:
            state_path = Path(d) / "state.json"
            project = sy.new_project(d, "demo")
            sessions, services = [], []
            for n in range(2):
                svc = sy.new_service(project, f"s{n}", f'"{sys.executable}" -c "import time; time.sleep(60)"')
                services.append(svc)
                sessions.append(sy.new_session(f"dev{n}", [svc.id]))
            sy.save_state(sy.WorkspaceState(projects=[project], services=services, sessions=sessions), state_path)
            h = Harness()
            for se in sessions:
                reply, _, _ = h.call("switchyard.start_session", {"session_id": se.id, "state_path": str(state_path), "runtime_path": str(Path(d) / "rt.json")})
                self.assertTrue(reply["result"]["started"])
            deadline = time.time() + 15
            while time.time() < deadline:
                status, _, _ = h.call("switchyard.status")
                if all(s["services"][0]["pid"] for s in status["result"]):
                    break
                time.sleep(0.1)
            pids = [s["services"][0]["pid"] for s in status["result"]]
            reply, _, _ = h.call("core.shutdown")
            self.assertEqual(reply["result"], {"stopped": True})
            # By the time the reply exists, every service is already gone.
            self.assertFalse([pid for pid in pids if _alive(pid)])
            reply, _, _ = h.call("switchyard.start_session", {"session_id": sessions[0].id, "state_path": str(state_path)})
            self.assertEqual(reply["error"]["kind"], "shutting_down")


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

            reply, during, _ = h.call("switchyard.start_session", {**paths, "session_id": session.id})
            self.assertTrue(reply["result"]["started"], reply)
            deadline = time.time() + 15
            # The session can announce itself before the reply is written.
            seen: list[str] = [e for e, _ in during]
            while time.time() < deadline and "switchyard.service_ready" not in seen:
                seen += [m["event"] for m in h.messages() if "event" in m]
                time.sleep(0.1)
            self.assertIn("switchyard.session_started", seen)
            self.assertIn("switchyard.service_ready", seen)

            status, _, _ = h.call("switchyard.status")
            mine = next(s for s in status["result"] if s["session_id"] == session.id)
            self.assertIsInstance(mine["services"][0]["pid"], int)

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

    def test_a_script_service_really_runs(self):
        """In process, with every message kept: on failure this shows the
        service's own output (switchyard.log), which says why it did not run."""
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
            h = Harness()
            params = {"session_id": session.id, "state_path": str(state_path), "runtime_path": str(Path(d) / "rt.json")}
            reply, _, _ = h.call("switchyard.start_session", params)
            try:
                deadline = time.time() + 15
                while not pidfile.exists() and time.time() < deadline:
                    time.sleep(0.1)
                time.sleep(0.5)
                self.assertTrue(pidfile.exists(), "service output and events:\n" + h.out.getvalue())
            finally:
                h.call("switchyard.stop_session", {"session_id": session.id})

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
            # Read what depot-core says until the service reports in, so a
            # failure shows Switchyard's events. (Not after: closing stdout
            # below would wait for a reader still blocked on it.)
            seen: list[dict] = []
            ready = threading.Event()

            def read() -> None:
                for line in iter(proc.stdout.readline, ""):
                    message = json.loads(line)
                    seen.append(message)
                    if message.get("event") in ("switchyard.service_ready", "switchyard.service_unhealthy"):
                        ready.set()
                        return

            threading.Thread(target=read, daemon=True).start()
            ready.wait(timeout=30)
            deadline = time.time() + 15
            while not pidfile.exists() and time.time() < deadline:
                time.sleep(0.1)
            if not pidfile.exists():
                service_pid = next((m["payload"]["pid"] for m in seen if m.get("event") == "switchyard.service_started"), None)
                alive = _alive(service_pid) if service_pid else None
                self.fail(
                    f"the service never wrote its pid (shell pid {service_pid}, alive: {alive}); depot-core said:\n"
                    + "\n".join(map(json.dumps, seen))
                )
            started = next((m for m in seen if m.get("id") == 1), None)
            self.assertTrue(started and started["result"]["started"], started)
            pid = int(pidfile.read_text())

            proc.stdout.close()  # the host is gone: nobody reads any more…
            proc.stdin.close()   # …and nobody writes
            proc.wait(timeout=20)
            deadline = time.time() + 10
            while _alive(pid) and time.time() < deadline:
                time.sleep(0.1)
            self.assertFalse(_alive(pid), "the service outlived Depot")


def _alive(pid: int) -> bool:
    """Is a process running? A zombie (killed, not yet reaped) counts as dead."""
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out.split()
    stat = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(stat) and not stat.startswith("Z")


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
