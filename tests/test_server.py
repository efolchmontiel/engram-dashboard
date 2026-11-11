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
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from server import Config, create_server
import server

ENGRAM_BIN = os.environ.get("ENGRAM_BIN") or shutil.which("engram") or os.path.expanduser("~/.local/bin/engram")
EXPECTED_ENGRAM_VERSION = os.environ.get("ENGRAM_EXPECTED_VERSION", "3.7.0")

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

    def test_patch_clears_topic_key_only_with_an_empty_string(self):
        """El motor rechaza null y limpia con cadena vacía; la UI depende de eso."""
        obs_id = self._own_obs("tema")
        status, _ = self.client.patch(
            f"/api/observations/{obs_id}?expected_project={PROJECT}",
            {"topic_key": "tema/clave"})
        self.assertEqual(status, 200)
        status, body = self.client.patch(
            f"/api/observations/{obs_id}?expected_project={PROJECT}",
            {"topic_key": None})
        self.assertEqual(status, 400, body)
        status, after = self.client.get(f"/api/observations/{obs_id}")
        self.assertEqual(after["topic_key"], "tema/clave")
        status, body = self.client.patch(
            f"/api/observations/{obs_id}?expected_project={PROJECT}",
            {"topic_key": ""})
        self.assertEqual(status, 200, body)
        status, after = self.client.get(f"/api/observations/{obs_id}")
        self.assertEqual(status, 200)
        self.assertIsNone(after.get("topic_key"))

    def test_delete_rejects_wrong_expected_project_without_deleting(self):
        obs_id = self._own_obs("borrado-proyecto")
        status, _ = self.client.delete(
            f"/api/observations/{obs_id}?expected_project=otro-proyecto"
        )
        self.assertEqual(status, 409)
        status, after = self.client.get(f"/api/observations/{obs_id}")
        self.assertEqual(status, 200)
        self.assertEqual(after["title"], "Obs efimera borrado-proyecto")


class DestructiveTests(DashboardFixture):
    """Borrados irreversibles: exigen un snapshot vigente del export completo.

    Cada test crea lo que borra, así el orden de ejecución no lo afecta.
    """

    SNAPSHOT_MAX_AGE = 600

    # --- helpers -------------------------------------------------------------

    def snapshot_dir(self):
        return os.path.join(self.data_dir, "dashboard-snapshots")

    def take_snapshot(self):
        status, body = self.client.post("/api/snapshots", {})
        self.assertEqual(status, 200, body)
        self.assertEqual(os.path.dirname(body["path"]), self.snapshot_dir())
        self.assertTrue(os.path.isfile(body["path"]))
        self.assertGreater(body["bytes"], 0)
        return body["path"]

    @staticmethod
    def q(path):
        return urllib.parse.quote(path, safe="")

    def own_obs(self, tag, session_id=S1):
        status, body = self.api.post("/observations", {
            "session_id": session_id, "project": PROJECT, "type": "decision",
            "title": f"Obs destructiva {tag}",
            "content": f"contenido destructivo unico {tag}"})
        assert status == 201, body
        return body["id"]

    def own_prompt(self, tag, session_id=S1):
        status, body = self.api.post("/prompts", {
            "session_id": session_id, "project": PROJECT,
            "content": f"prompt destructivo unico {tag}"})
        assert status == 201, body
        return body["id"]

    def own_session(self, tag):
        sid = "sess-" + tag
        status, body = self.api.post("/sessions", {
            "id": sid, "project": PROJECT, "directory": "/tmp/" + sid})
        assert status == 201, body
        return sid

    def prompt_ids(self):
        status, body = self.client.get(
            f"/api/prompts?project={PROJECT}&limit=200")
        self.assertEqual(status, 200, body)
        return [p["id"] for p in body["prompts"]]

    def session_ids(self):
        status, body = self.client.get(
            f"/api/sessions/recent?project={PROJECT}&limit=200")
        self.assertEqual(status, 200, body)
        return [s["id"] for s in body["sessions"]]

    def obs_exists(self, obs_id):
        return self.client.get(f"/api/observations/{obs_id}")[0] == 200

    # --- snapshots -----------------------------------------------------------

    def test_snapshot_writes_global_export(self):
        path = self.take_snapshot()
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        self.assertIn("observations", payload)
        self.assertIn("exported_at", payload)
        # Export global: incluye la semilla del proyecto y lo que otros tests crearon.
        titles = {o["title"] for o in payload["observations"]}
        self.assertIn(OBS_A["title"], titles)
        self.assertGreaterEqual(len(payload["observations"]), 4)

    def test_snapshot_requires_reachable_engine(self):
        directory = self.snapshot_dir()
        before = set(os.listdir(directory)) if os.path.isdir(directory) else set()
        dead = free_port()
        cfg = Config(host="127.0.0.1", port=free_port(), engram_bin=ENGRAM_BIN,
                     engram_api=f"http://127.0.0.1:{dead}",
                     data_dir=self.data_dir)
        httpd = create_server(cfg)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            client = Http(f"http://127.0.0.1:{httpd.server_address[1]}")
            status, body = client.post("/api/snapshots", {})
            self.assertEqual(status, 502)
            self.assertIn("error", body)
            # Un motor caído no deja archivos a medias.
            after = set(os.listdir(directory)) if os.path.isdir(directory) else set()
            self.assertEqual(after, before)
        finally:
            httpd.shutdown()
            httpd.server_close()

    # --- observaciones: soft vs hard -----------------------------------------

    def test_soft_delete_does_not_require_snapshot(self):
        obs_id = self.own_obs("soft-sin-snapshot")
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}")
        self.assertEqual(status, 200, body)
        self.assertFalse(body["hard_delete"])
        self.assertFalse(self.obs_exists(obs_id))

    def test_hard_delete_removes_observation_permanently(self):
        obs_id = self.own_obs("hard")
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}"
            f"&hard=true&snapshot={self.q(snap)}")
        self.assertEqual(status, 200, body)
        self.assertTrue(body["hard_delete"])
        self.assertFalse(self.obs_exists(obs_id))

    def test_hard_delete_also_purges_a_soft_deleted_observation(self):
        obs_id = self.own_obs("purga")
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}")
        self.assertEqual(status, 200, body)
        self.assertFalse(body["hard_delete"])
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}"
            f"&hard=true&snapshot={self.q(snap)}")
        self.assertEqual(status, 200, body)
        self.assertTrue(body["hard_delete"])
        self.assertFalse(self.obs_exists(obs_id))

    def test_hard_delete_without_snapshot_is_refused(self):
        obs_id = self.own_obs("hard-sin-snapshot")
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}&hard=true")
        self.assertEqual(status, 403, body)
        self.assertIn("snapshot", body["error"].lower())
        self.assertTrue(self.obs_exists(obs_id))

    def test_hard_delete_refuses_snapshot_outside_snapshot_dir(self):
        obs_id = self.own_obs("hard-snapshot-ajeno")
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}"
            f"&hard=true&snapshot={self.q('/etc/hostname')}")
        self.assertEqual(status, 403, body)
        self.assertIn("snapshot", body["error"].lower())
        self.assertTrue(self.obs_exists(obs_id))

    def test_hard_delete_refuses_stale_snapshot(self):
        obs_id = self.own_obs("hard-snapshot-viejo")
        snap = self.take_snapshot()
        old = time.time() - (self.SNAPSHOT_MAX_AGE + 60)
        os.utime(snap, (old, old))
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}"
            f"&hard=true&snapshot={self.q(snap)}")
        self.assertEqual(status, 403, body)
        self.assertIn("snapshot", body["error"].lower())
        self.assertTrue(self.obs_exists(obs_id))

    def test_hard_delete_requires_expected_project(self):
        obs_id = self.own_obs("hard-sin-proyecto")
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?hard=true&snapshot={self.q(snap)}")
        self.assertEqual(status, 400, body)
        self.assertIn("expected_project", body["error"])
        self.assertTrue(self.obs_exists(obs_id))

    def test_hard_flag_rejects_non_boolean_value(self):
        obs_id = self.own_obs("hard-invalido")
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/observations/{obs_id}?expected_project={PROJECT}"
            f"&hard=quizas&snapshot={self.q(snap)}")
        self.assertEqual(status, 400, body)
        self.assertIn("hard", body["error"].lower())
        self.assertTrue(self.obs_exists(obs_id))

    # --- prompts -------------------------------------------------------------

    def test_prompt_list_shows_seeded_prompt(self):
        pid = self.own_prompt("listado")
        self.assertIn(pid, self.prompt_ids())

    def test_prompt_delete_is_permanent(self):
        pid = self.own_prompt("borrado")
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/prompts/{pid}?snapshot={self.q(snap)}")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["status"], "deleted")
        self.assertNotIn(pid, self.prompt_ids())

    def test_prompt_delete_requires_snapshot(self):
        pid = self.own_prompt("sin-snapshot")
        status, body = self.client.delete(f"/api/prompts/{pid}")
        self.assertEqual(status, 403, body)
        self.assertIn("snapshot", body["error"].lower())
        self.assertIn(pid, self.prompt_ids())

    def test_prompt_delete_unknown_is_404(self):
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/prompts/999999?snapshot={self.q(snap)}")
        self.assertEqual(status, 404, body)
        self.assertIn("error", body)

    # --- sesiones ------------------------------------------------------------

    def test_empty_session_delete_is_permanent(self):
        sid = self.own_session("vacia")
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/sessions/{sid}?snapshot={self.q(snap)}")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["status"], "deleted")
        self.assertNotIn(sid, self.session_ids())

    def test_session_with_observations_is_refused_with_409(self):
        sid = self.own_session("conobs")
        self.own_obs("en-sesion", session_id=sid)
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/sessions/{sid}?snapshot={self.q(snap)}")
        self.assertEqual(status, 409, body)
        self.assertIn("observation", body["error"])
        self.assertIn(sid, self.session_ids())

    def test_session_delete_requires_snapshot(self):
        sid = self.own_session("sin-snapshot")
        status, body = self.client.delete(f"/api/sessions/{sid}")
        self.assertEqual(status, 403, body)
        self.assertIn("snapshot", body["error"].lower())
        self.assertIn(sid, self.session_ids())


class ProjectCascadeTests(DashboardFixture):
    """Cascada de proyecto vía el CLI del motor, con snapshot obligatorio.

    Cada test crea su propio proyecto efímero y lo destruye: el orden no
    afecta y la semilla de la clase queda intacta para los test de rechazo.
    """

    # --- helpers -------------------------------------------------------------

    def snapshot_dir(self):
        return os.path.join(self.data_dir, "dashboard-snapshots")

    def take_snapshot(self):
        status, body = self.client.post("/api/snapshots", {})
        self.assertEqual(status, 200, body)
        self.assertEqual(os.path.dirname(body["path"]), self.snapshot_dir())
        return body["path"]

    @staticmethod
    def q(path):
        return urllib.parse.quote(path, safe="")

    def own_project(self, tag):
        """Proyecto efímero con una sesión, una observación y un prompt."""
        name = f"cascade-{tag}"
        sid = "sess-" + tag
        status, body = self.api.post("/sessions", {
            "id": sid, "project": name, "directory": "/tmp/" + sid})
        assert status == 201, body
        status, body = self.api.post("/observations", {
            "session_id": sid, "project": name, "type": "decision",
            "title": f"Obs cascada {tag}",
            "content": f"contenido cascada unico {tag}"})
        assert status == 201, body
        status, body = self.api.post("/prompts", {
            "session_id": sid, "project": name,
            "content": f"prompt cascada unico {tag}"})
        assert status == 201, body
        return name, sid

    def seed_obs_count(self):
        status, body = self.client.get("/api/observations?project=" + PROJECT)
        self.assertEqual(status, 200, body)
        return len(body["observations"])

    # --- cascada soft ---------------------------------------------------------

    def test_cascade_soft_deletes_observations_and_prompts_keeps_sessions(self):
        name, sid = self.own_project("soft")
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/projects/{urllib.parse.quote(name, safe='')}"
            f"?snapshot={self.q(snap)}")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["project"], name)
        self.assertFalse(body["hard"])
        self.assertEqual(body["observations"], 1)
        self.assertEqual(body["prompts"], 1)
        # El CLI cuenta las sesiones que BORRA: en soft, ninguna.
        self.assertEqual(body["sessions"], 0)
        # Las observaciones del proyecto desaparecen de los listados activos.
        status, obs = self.client.get("/api/observations?project=" + name)
        self.assertEqual(status, 200)
        self.assertEqual(obs["observations"], [])
        # El prompt se borró para siempre (el motor no ofrece soft de prompts).
        status, prompts = self.client.get("/api/prompts?project=" + name)
        self.assertEqual(status, 200)
        self.assertEqual(prompts["prompts"], [])
        # La sesión sobrevive vacía.
        status, sessions = self.client.get("/api/sessions/recent?project=" + name)
        self.assertEqual(status, 200)
        self.assertEqual([s["id"] for s in sessions["sessions"]], [sid])
        self.assertTrue(body["cli_output"])

    def test_cascade_hard_removes_sessions_too(self):
        name, sid = self.own_project("hard")
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/projects/{urllib.parse.quote(name, safe='')}"
            f"?hard=true&snapshot={self.q(snap)}")
        self.assertEqual(status, 200, body)
        self.assertEqual(body["project"], name)
        self.assertTrue(body["hard"])
        self.assertEqual(body["observations"], 1)
        self.assertEqual(body["prompts"], 1)
        # En hard el CLI reporta la sesión que borró.
        self.assertEqual(body["sessions"], 1)
        # Con el proyecto ya inexistente, el motor responde 404 (o una lista vacía).
        status, obs = self.client.get("/api/observations?project=" + name)
        self.assertIn(status, (200, 404), obs)
        if status == 200:
            self.assertEqual(obs["observations"], [])
        status, sessions = self.client.get("/api/sessions/recent?project=" + name)
        self.assertIn(status, (200, 404), sessions)
        if status == 200:
            self.assertEqual(sessions["sessions"], [])

    # --- rechazos -------------------------------------------------------------

    def test_cascade_without_snapshot_is_refused_and_data_intact(self):
        name, sid = self.own_project("sin-snapshot")
        status, body = self.client.delete("/api/projects/" + name)
        self.assertEqual(status, 403, body)
        self.assertIn("snapshot", body["error"].lower())
        status, obs = self.client.get("/api/observations?project=" + name)
        self.assertEqual(status, 200)
        self.assertEqual(len(obs["observations"]), 1)
        status, sessions = self.client.get("/api/sessions/recent?project=" + name)
        self.assertEqual(status, 200)
        self.assertIn(sid, [s["id"] for s in sessions["sessions"]])

    def test_cascade_refuses_unknown_project_name(self):
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/projects/proyecto-inexistente-cascada?snapshot={self.q(snap)}")
        self.assertEqual(status, 400, body)
        self.assertIn("proyecto-inexistente-cascada", body["error"])
        # La semilla y sus datos quedan intactos: nada corrió contra el motor.
        self.assertEqual(self.seed_obs_count(), 4)

    def test_cascade_refuses_injection_shaped_names(self):
        snap = self.take_snapshot()
        before = self.seed_obs_count()
        for name in ("-rf", "foo/../bar", "proj%2F%2E%2E%2Fbar"):
            status, body = self.client.delete(
                f"/api/projects/{name}?snapshot={self.q(snap)}")
            self.assertEqual(status, 400, (name, body))
            self.assertIn("error", body)
        self.assertEqual(self.seed_obs_count(), before)

    def test_cascade_rejects_non_boolean_hard_value(self):
        name, sid = self.own_project("hard-invalido")
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/projects/{name}?hard=quizas&snapshot={self.q(snap)}")
        self.assertEqual(status, 400, body)
        self.assertIn("hard", body["error"].lower())
        status, obs = self.client.get("/api/observations?project=" + name)
        self.assertEqual(status, 200)
        self.assertEqual(len(obs["observations"]), 1)

    # --- caminos de error del CLI --------------------------------------------

    def fake_bin(self, script):
        """Dashboard con un binario de motor falso, para forzar fallos del CLI."""
        path = os.path.join(self.data_dir, "fake-engram")
        with open(path, "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\n" + script)
        os.chmod(path, 0o755)
        cfg = Config(host="127.0.0.1", port=0, engram_bin=path,
                     engram_api=self.api.base, data_dir=self.data_dir)
        httpd = create_server(cfg)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return Http(f"http://127.0.0.1:{httpd.server_address[1]}")

    def test_cascade_cli_failure_is_502_without_claiming_success(self):
        name, _ = self.own_project("cli-falla")
        snap = self.take_snapshot()
        path = f"/api/projects/{name}?snapshot={self.q(snap)}"
        # Salida no cero y salida cero sin el formato esperado.
        for script in ('echo boom >&2; exit 3\n', 'echo "sin conteos"; exit 0\n'):
            client = self.fake_bin(script)
            status, body = client.delete(path)
            self.assertEqual(status, 502, (script, body))
            self.assertIn("no se declara éxito", body["error"])
            self.assertNotIn("sessions", body)
        # El CLI falso nunca tocó el store: el proyecto sigue entero.
        status, obs = self.client.get("/api/observations?project=" + name)
        self.assertEqual(status, 200)
        self.assertEqual(len(obs["observations"]), 1)

    def test_cascade_error_output_is_bounded(self):
        name, _ = self.own_project("cli-verboso")
        snap = self.take_snapshot()
        client = self.fake_bin(
            'head -c 9000 /dev/zero | tr "\\0" "x" >&2; exit 4\n')
        status, body = client.delete(
            f"/api/projects/{name}?snapshot={self.q(snap)}")
        self.assertEqual(status, 502, body)
        self.assertIn("no se declara éxito", body["error"])
        self.assertLessEqual(len(body["error"]), 600)

    def test_cascade_refuses_help_shaped_project_name(self):
        # El motor lista un proyecto "-h"; el CLI lo interpreta como ayuda y
        # termina sin borrar. Nunca se declara éxito y la sesión sobrevive.
        status, body = self.api.post("/sessions", {
            "id": "sess-help", "project": "-h", "directory": "/tmp/sess-help"})
        self.assertEqual(status, 201, body)
        snap = self.take_snapshot()
        status, body = self.client.delete(
            f"/api/projects/-h?snapshot={self.q(snap)}")
        self.assertEqual(status, 502, body)
        self.assertNotIn("sessions", body)
        status, _ = self.client.get("/api/sessions/sess-help")
        self.assertEqual(status, 200)


class DeleteContractTests(unittest.TestCase):
    """La interfaz no puede borrar de forma permanente sin snapshot (S3).

    No hay runner de JS en este repo, así que el invariante se comprueba sobre
    el fuente: toda llamada DELETE debe llevar `snapshot=` en su vecindario
    salvo el borrado soft de una observación, que es el único exento.
    """

    APP_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "static", "app.js")
    WINDOW = 4

    def test_only_the_soft_observation_delete_skips_the_snapshot(self):
        with open(self.APP_JS, encoding="utf-8") as f:
            lines = f.read().splitlines()

        seen, offenders = [], []
        for index, line in enumerate(lines):
            if 'method: "DELETE"' not in line:
                continue
            seen.append(index + 1)
            window = "\n".join(lines[max(0, index - self.WINDOW):index + 1])
            if "snapshot=" not in window:
                offenders.append((index + 1, line.strip()))

        self.assertGreaterEqual(len(seen), 5, f"no se encontraron los DELETE esperados: {seen}")
        self.assertEqual(len(offenders), 1,
                         f"DELETE sin snapshot fuera del soft: {offenders}")
        _lineno, soft = offenders[0]
        self.assertIn("expected_project=", soft)
        self.assertNotIn("hard=true", soft)


if __name__ == "__main__":
    unittest.main()
