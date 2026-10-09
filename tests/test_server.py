"""Tests de integración del dashboard local de Engram.

Levantan un `engram serve` real contra un directorio de datos efímero y el
backend del dashboard en un hilo, y verifican el contrato HTTP completo.
Solo localhost: nada toca la base de datos real del usuario.
"""

import datetime
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from server import Config, create_server
import server

ENGRAM_BIN = os.environ.get("ENGRAM_BIN") or shutil.which("engram") or os.path.expanduser("~/.local/bin/engram")
EXPECTED_ENGRAM_VERSION = os.environ.get("ENGRAM_EXPECTED_VERSION", "3.2.1")

PROJECT = "projtest"
S1, S2 = "sess-alpha", "sess-beta"
OBS_A = {"session_id": S1, "project": PROJECT, "type": "decision",
         "title": "Decision alpha uno", "content": "contenido unico KIWI sobre despliegue"}
OBS_B = {"session_id": S1, "project": PROJECT, "type": "bugfix",
         "title": "Bugfix beta dos", "content": "contenido unico MANGO sobre un fix de memoria"}
OBS_C = {"session_id": S2, "project": PROJECT, "type": "config",
         "title": "Config gamma tres", "content": "contenido unico NUEZ de configuracion"}
OBS_D = {"session_id": S2, "project": PROJECT, "type": "discovery",
         "title": "Discovery delta cuatro", "content": "contenido unico PIPA de descubrimiento"}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_health(base, timeout=15.0):
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/health", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("engram serve no respondió a /health en " + base)


class Http:
    """Cliente HTTP mínimo que devuelve (status, datos) sin lanzar por 4xx/5xx."""

    def __init__(self, base):
        self.base = base

    def request(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return self._decode(r.status, r.read(), r.headers.get_content_type())
        except urllib.error.HTTPError as e:
            result = self._decode(e.code, e.read(), e.headers.get_content_type())
            e.close()
            return result

    @staticmethod
    def _decode(status, raw, content_type):
        if content_type == "application/json" and raw:
            return status, json.loads(raw)
        return status, raw.decode(errors="replace")

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, body):
        return self.request("POST", path, body)

    def patch(self, path, body):
        return self.request("PATCH", path, body)

    def delete(self, path):
        return self.request("DELETE", path)


class DashboardFixture(unittest.TestCase):
    """Un `engram serve` efímero + backend del dashboard por clase de tests.

    Las clases concretas deciden su semilla: las de lectura comparten una
    semilla inmutable y las de mutación usan una propia para no contaminarse.
    """

    @classmethod
    def setUpClass(cls):
        cls.data_dir = tempfile.mkdtemp(prefix="engram-dash-test-")
        cls.api_port = free_port()
        env = dict(os.environ, ENGRAM_DATA_DIR=cls.data_dir)
        cls.engram_proc = subprocess.Popen(
            [ENGRAM_BIN, "serve", str(cls.api_port)], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.api = Http(f"http://127.0.0.1:{cls.api_port}")
        wait_health(cls.api.base)
        cls._seed()

        cls.dash_port = free_port()
        cls.config = Config(
            host="127.0.0.1", port=cls.dash_port,
            engram_bin=ENGRAM_BIN, engram_api=cls.api.base,
            data_dir=cls.data_dir)
        cls.httpd = create_server(cls.config)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = Http(f"http://127.0.0.1:{cls.dash_port}")

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.engram_proc.terminate()
        cls.engram_proc.wait(timeout=10)
        shutil.rmtree(cls.data_dir, ignore_errors=True)

    @classmethod
    def _seed(cls):
        for sid in (S1, S2):
            status, _ = cls.api.post("/sessions", {
                "id": sid, "project": PROJECT, "directory": "/tmp/" + sid})
            assert status == 201, f"seed session {sid} -> {status}"
        for obs in (OBS_A, OBS_B, OBS_C, OBS_D):
            status, body = cls.api.post("/observations", obs)
            assert status == 201, f"seed obs -> {status} {body}"

class ReadOpsTests(DashboardFixture):
    """Tests de solo lectura sobre la semilla inmutable."""

    # --- estáticos y errores -------------------------------------------------

    def test_serves_index_html(self):
        status, body = self.client.get("/")
        self.assertEqual(status, 200)
        self.assertIn("Engram", body)

    def test_unknown_route_is_json_404(self):
        status, body = self.client.get("/api/nope")
        self.assertEqual(status, 404)
        self.assertIn("error", body)
        status, _ = self.client.get("/esta-ruta-no-existe")
        self.assertEqual(status, 404)

    # --- salud y sistema -----------------------------------------------------

    def test_health_reports_engram_version(self):
        status, body = self.client.get("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["engram"]["version"], EXPECTED_ENGRAM_VERSION)

    def test_system_reports_paths_and_binary(self):
        status, body = self.client.get("/api/system")
        self.assertEqual(status, 200)
        self.assertEqual(body["data_dir"], self.data_dir)
        self.assertEqual(body["db_path"], os.path.join(self.data_dir, "engram.db"))
        self.assertTrue(body["engram_bin"].endswith("engram"))
        self.assertEqual(body["api_base"], self.api.base)
        self.assertEqual(body["host"], "127.0.0.1")

    def test_doctor_passthrough(self):
        status, body = self.client.get("/api/doctor?project=" + PROJECT)
        self.assertEqual(status, 200)
        self.assertIn(body["status"], ("ok", "warning"))
        self.assertTrue(len(body["checks"]) > 0)

    def test_binds_loopback_only(self):
        self.assertEqual(self.httpd.server_address[0], "127.0.0.1")

    def test_engram_down_returns_502(self):
        dead_port = free_port()
        cfg = Config(host="127.0.0.1", port=free_port(), engram_bin=ENGRAM_BIN,
                     engram_api=f"http://127.0.0.1:{dead_port}",
                     data_dir=self.data_dir)
        httpd = create_server(cfg)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            client = Http(f"http://127.0.0.1:{httpd.server_address[1]}")
            status, body = client.get("/api/health")
            self.assertEqual(status, 502)
            self.assertIn("error", body)
        finally:
            httpd.shutdown()
            httpd.server_close()

    # --- proyectos -----------------------------------------------------------

    def test_projects_match_engine_counts(self):
        status, body = self.client.get("/api/projects")
        self.assertEqual(status, 200)
        entry = next(p for p in body["projects"] if p["name"] == PROJECT)
        self.assertEqual(entry["observations"], 4)
        self.assertEqual(entry["sessions"], 2)
        self.assertEqual(entry["prompts"], 0)
        self.assertIn("directories", entry)
        _, engine = self.api.get("/projects")
        engine_entry = next(p for p in engine["projects"] if p["name"] == PROJECT)
        self.assertEqual(entry["observations"], engine_entry["observation_count"])
        self.assertEqual(entry["sessions"], engine_entry["session_count"])
        self.assertEqual(entry["prompts"], engine_entry["prompt_count"])

    def test_expected_version_matches_verified_constant(self):
        self.assertEqual(EXPECTED_ENGRAM_VERSION, server.VERIFIED_ENGRAM_VERSION)

    # --- observaciones -------------------------------------------------------

    def test_observations_bulk_returns_active(self):
        status, body = self.client.get("/api/observations?project=" + PROJECT)
        self.assertEqual(status, 200)
        self.assertEqual(body["project"], PROJECT)
        titles = {o["title"] for o in body["observations"]}
        self.assertEqual(titles, {OBS_A["title"], OBS_B["title"],
                                  OBS_C["title"], OBS_D["title"]})

    def test_observations_requires_scope(self):
        status, body = self.client.get("/api/observations")
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_observations_global_scope(self):
        status, body = self.client.get("/api/observations?all_projects=true")
        self.assertEqual(status, 200)
        self.assertEqual(body["scope"], "all")
        self.assertEqual(len(body["observations"]), 4)
        self.assertFalse(body["truncated"])
        self.assertTrue(all(o["project"] == PROJECT for o in body["observations"]))

    def test_observations_reports_truncation(self):
        status, body = self.client.get(f"/api/observations?project={PROJECT}&limit=2")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["observations"]), 2)
        self.assertTrue(body["truncated"])

    def test_observation_detail(self):
        status, bulk = self.client.get("/api/observations?project=" + PROJECT)
        obs_id = bulk["observations"][0]["id"]
        status, body = self.client.get(f"/api/observations/{obs_id}")
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], obs_id)

    def test_observation_detail_404(self):
        status, body = self.client.get("/api/observations/999999")
        self.assertEqual(status, 404)
        self.assertIn("error", body)

    def test_search_uses_fts(self):
        status, body = self.client.get(
            f"/api/search?q=KIWI&project={PROJECT}")
        self.assertEqual(status, 200)
        self.assertEqual([o["title"] for o in body["results"]], [OBS_A["title"]])

    def test_search_requires_query(self):
        status, _ = self.client.get(f"/api/search?project={PROJECT}")
        self.assertEqual(status, 400)

    def test_search_global_scope(self):
        status, body = self.client.get("/api/search?q=KIWI&all_projects=true")
        self.assertEqual(status, 200)
        self.assertEqual([o["title"] for o in body["results"]], [OBS_A["title"]])

    # --- sesiones ------------------------------------------------------------

    def test_sessions_recent_lists_seed(self):
        status, body = self.client.get(f"/api/sessions/recent?project={PROJECT}")
        self.assertEqual(status, 200)
        ids = {s["id"] for s in body["sessions"]}
        self.assertEqual(ids, {S1, S2})
        for s in body["sessions"]:
            self.assertIn("observation_count", s)

    def test_session_detail(self):
        status, body = self.client.get(f"/api/sessions/{S1}")
        self.assertEqual(status, 200)
        self.assertEqual(body["project"], PROJECT)
        status, _ = self.client.get("/api/sessions/sess-nope")
        self.assertEqual(status, 404)

    def test_sessions_global_scope(self):
        status, body = self.client.get("/api/sessions/recent?all_projects=true")
        self.assertEqual(status, 200)
        self.assertEqual(body["scope"], "all")
        self.assertEqual({s["id"] for s in body["sessions"]}, {S1, S2})
        self.assertEqual(body["limit"], 100)
        self.assertFalse(body["truncated"])

    def test_sessions_report_truncation(self):
        status, body = self.client.get(f"/api/sessions/recent?project={PROJECT}&limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["sessions"]), 1)
        self.assertTrue(body["truncated"])

    # --- agregados -----------------------------------------------------------

    def test_overview_aggregates(self):
        status, body = self.client.get("/api/overview")
        self.assertEqual(status, 200)
        self.assertIn(body["health"]["status"], ("ok", "warning"))
        names = [p["name"] for p in body["projects"]]
        self.assertIn(PROJECT, names)
        self.assertEqual(body["totals"]["observations"], 4)
        self.assertEqual(body["totals"]["sessions"], 2)
        self.assertEqual(body["totals"]["projects"], 1)
        self.assertTrue(len(body["recent"]) > 0)
        self.assertTrue(all("title" in o for o in body["recent"]))

    def test_overview_activity_stats(self):
        status, body = self.client.get("/api/overview")
        self.assertEqual(status, 200)
        act = body["activity"]
        # Las 4 observaciones de la semilla se crean "ahora" (UTC del servidor).
        self.assertEqual(act["d1"], 4)
        self.assertEqual(act["d7"], 4)
        self.assertEqual(act["d30"], 4)

    def test_overview_type_distribution(self):
        status, body = self.client.get("/api/overview")
        self.assertEqual(status, 200)
        self.assertEqual(body["activity"]["by_type"],
                         {"decision": 1, "bugfix": 1, "config": 1, "discovery": 1})

    def test_overview_daily_series(self):
        status, body = self.client.get("/api/overview")
        self.assertEqual(status, 200)
        by_day = body["activity"]["by_day"]
        days = list(by_day)
        self.assertEqual(len(days), 30, days)
        self.assertEqual(days, sorted(days))
        today = datetime.datetime.now(datetime.timezone.utc).date()
        self.assertEqual(days[0], (today - datetime.timedelta(days=29)).isoformat())
        self.assertEqual(days[-1], today.isoformat())
        # La semilla crea sus 4 observaciones "ahora": todo cae en el último día.
        self.assertEqual(sum(by_day.values()), 4)
        self.assertEqual(by_day[days[-1]], 4)
        self.assertEqual([v for d, v in by_day.items() if d != days[-1]], [0] * 29)

    def test_overview_projects_carry_last_activity(self):
        status, body = self.client.get("/api/overview")
        self.assertEqual(status, 200)
        by_name = {p["name"]: p for p in body["projects"]}
        self.assertIn(PROJECT, by_name)
        # La semilla escribe sus 4 observaciones "ahora": hay fecha y no es futura.
        seen = by_name[PROJECT]["last_activity"]
        self.assertTrue(seen, by_name[PROJECT])
        self.assertLessEqual(seen[:10], datetime.datetime.now(
            datetime.timezone.utc).date().isoformat())

    def test_overview_declares_scope_and_load_time(self):
        status, body = self.client.get("/api/overview")
        self.assertEqual(status, 200)
        self.assertEqual(body["scope"], "all")
        self.assertTrue(body["loaded_at"])
        self.assertFalse(body["truncated"])
        self.assertEqual(body["observations_loaded"], 4)
        self.assertEqual(body["stats"]["total_observations"], 4)

    def test_overview_stays_within_upstream_request_budget(self):
        calls = []
        original = server.Handler.upstream

        def counting(self, method, path_query, payload=None):
            calls.append(path_query)
            return original(self, method, path_query, payload)

        with mock.patch.object(server.Handler, "upstream", counting):
            status, _ = self.client.get("/api/overview")
        self.assertEqual(status, 200)
        self.assertLessEqual(len(calls), 6, calls)

    # --- superficies nuevas (stats, salud, export) ----------------------------

    def test_stats_global_totals(self):
        status, body = self.client.get("/api/stats?all_projects=true")
        self.assertEqual(status, 200)
        self.assertEqual(body["total_observations"], 4)
        self.assertEqual(body["total_sessions"], 2)
        self.assertIn(PROJECT, body["projects"])

    def test_conflicts_list_structure(self):
        status, body = self.client.get(f"/api/conflicts?project={PROJECT}")
        self.assertEqual(status, 200)
        self.assertEqual(body["relations"], [])
        self.assertEqual(body["total"], 0)
        self.assertIn("limit", body)

    def test_conflicts_stats_structure(self):
        status, body = self.client.get(f"/api/conflicts/stats?project={PROJECT}")
        self.assertEqual(status, 200)
        self.assertIn("by_judgment_status", body)
        self.assertIn("by_relation", body)

    def test_conflicts_detail_passes_through_404(self):
        status, body = self.client.get("/api/conflicts/999999")
        self.assertEqual(status, 404)
        self.assertNotIn("surface", body)

    def test_review_queue_structure(self):
        status, body = self.client.get(f"/api/review?project={PROJECT}")
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 0)
        self.assertEqual(body["observations"], [])

    def test_export_requires_project(self):
        status, body = self.client.get("/api/export")
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_export_returns_engine_collection(self):
        status, body = self.client.get(f"/api/export?project={PROJECT}")
        self.assertEqual(status, 200)
        self.assertIn("version", body)
        self.assertIn("exported_at", body)
        self.assertEqual(len(body["observations"]), 4)

    def test_missing_surface_degrades_explicitly(self):
        """Un motor sin la superficie nueva produce 404 explícito y aviso de versión."""

        class Stub(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                if self.path.startswith("/health"):
                    raw = json.dumps({"status": "ok", "version": "3.0.0"}).encode()
                    code = 200
                else:
                    raw = b"404 page not found"
                    code = 404
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        stub = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=stub.serve_forever, daemon=True).start()
        cfg = Config(host="127.0.0.1", port=free_port(), engram_bin=ENGRAM_BIN,
                     engram_api=f"http://127.0.0.1:{stub.server_address[1]}",
                     data_dir=self.data_dir)
        httpd = create_server(cfg)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            client = Http(f"http://127.0.0.1:{httpd.server_address[1]}")
            status, body = client.get("/api/conflicts")
            self.assertEqual(status, 404)
            self.assertEqual(body.get("surface"), "conflicts")
            status, body = client.get("/api/system")
            self.assertEqual(status, 200)
            self.assertEqual(body["version"], "3.0.0")
            self.assertFalse(body["compatible"])
            self.assertEqual(body["verified_version"], server.VERIFIED_ENGRAM_VERSION)
            self.assertEqual(client.get("/api/health")[0], 200)
        finally:
            httpd.shutdown()
            httpd.server_close()
            stub.shutdown()
            stub.server_close()


class MutationTests(DashboardFixture):
    """Tests que editan/borran: crean primero sus propias observaciones."""

    def _own_obs(self, tag, obs_type="decision"):
        status, body = self.api.post("/observations", {
            "session_id": S1, "project": PROJECT, "type": obs_type,
            "title": f"Obs efimera {tag}",
            "content": f"contenido efimero unico {tag} para mutacion"})
        assert status == 201, body
        return body["id"]

    def test_patch_edits_observation(self):
        obs_id = self._own_obs("parche")
        status, body = self.client.patch(
            f"/api/observations/{obs_id}?expected_project={PROJECT}",
            {
                "title": "Obs parche editada",
                "content": "contenido parche revisado",
                "type": "architecture",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["title"], "Obs parche editada")
        self.assertEqual(body["type"], "architecture")
        self.assertEqual(body["revision_count"], 2)
        _, after = self.client.get(f"/api/observations/{obs_id}")
        self.assertEqual(after["content"], "contenido parche revisado")

    def test_patch_rejects_wrong_expected_project_without_mutation(self):
        obs_id = self._own_obs("parche-proyecto")
        status, _ = self.client.patch(
            f"/api/observations/{obs_id}?expected_project=otro-proyecto",
            {"title": "No debe cambiar"},
        )
        self.assertEqual(status, 409)
        _, after = self.client.get(f"/api/observations/{obs_id}")
        self.assertEqual(after["title"], "Obs efimera parche-proyecto")

    def test_delete_is_soft_and_hidden(self):
        obs_id = self._own_obs("borrado")
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}"
        )
        self.assertEqual(status, 200)
        self.assertFalse(body["hard_delete"])
        status, _ = self.client.get(f"/api/observations/{obs_id}")
        self.assertEqual(status, 404)
        _, bulk = self.client.get("/api/observations?project=" + PROJECT)
        self.assertNotIn(obs_id, [o["id"] for o in bulk["observations"]])

    def test_delete_rejects_wrong_expected_project_without_deleting(self):
        obs_id = self._own_obs("borrado-proyecto")
        status, _ = self.client.delete(
            f"/api/observations/{obs_id}?expected_project=otro-proyecto"
        )
        self.assertEqual(status, 409)
        status, after = self.client.get(f"/api/observations/{obs_id}")
        self.assertEqual(status, 200)
        self.assertEqual(after["title"], "Obs efimera borrado-proyecto")


if __name__ == "__main__":
    unittest.main()
