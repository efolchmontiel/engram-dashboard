#!/usr/bin/env python3
"""Dashboard local para Engram 3.x — backend mínimo (solo stdlib).

No toca `~/.engram/engram.db` directamente: todo pasa por la API HTTP oficial
de `engram serve`. Escucha en loopback por defecto.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

STATIC_FILES = {"index.html", "app.js", "app.css", "favicon.svg"}

# Versión del motor contra la que está verificado el dashboard (única fuente:
# los tests comparan con ella y la UI avisa cuando el motor se sale de aquí).
VERIFIED_ENGRAM_VERSION = "3.7.0"
DEFAULT_LIMIT = 1000
MAX_LIMIT = 50000
OVERVIEW_LIMIT = 20000
ACTIVITY_DAYS = 30

# Snapshots de seguridad: un borrado irreversible exige uno vigente.
SNAPSHOT_SUBDIR = "dashboard-snapshots"
SNAPSHOT_MAX_AGE_SECONDS = 600

# Salida esperada del CLI: Project "NAME" ... N observation(s), M prompt(s), K session(s)
CLI_PROJECT_COUNTS = re.compile(
    r"(?P<observations>\d+)\s+observation(?:\(s\))?,\s*"
    r"(?P<prompts>\d+)\s+prompt(?:\(s\))?,\s*"
    r"(?P<sessions>\d+)\s+session(?:\(s\))?")
CLI_OUTPUT_MAX_CHARS = 500
CLI_ERROR_TAIL_MAX_CHARS = 300


@dataclass
class Config:
    host: str
    port: int
    engram_bin: str
    engram_api: str
    data_dir: str

    def snapshot_dir(self) -> str:
        """Directorio donde el dashboard escribe sus snapshots de export."""
        return (os.environ.get("ENGRAM_DASH_SNAPSHOT_DIR")
                or os.path.join(self.data_dir, SNAPSHOT_SUBDIR))


def map_projects(body) -> list:
    """Normaliza `GET /projects` del motor a la forma que consume la UI."""
    projects = []
    for p in (body or {}).get("projects", []):
        projects.append({
            "name": p.get("name"),
            "observations": p.get("observation_count", 0),
            "sessions": p.get("session_count", 0),
            "prompts": p.get("prompt_count", 0),
            "directories": p.get("directories") or [],
        })
    return projects


def clamp_int(value, low: int, high: int, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(n, high))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "engram-dashboard/1.0"

    @property
    def config(self) -> Config:
        return self.server.config

    def log_message(self, fmt, *args):
        if os.environ.get("ENGRAM_DASH_DEBUG"):
            super().log_message(fmt, *args)

    # --- utilidades HTTP -----------------------------------------------------

    def send_json(self, status: int, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, filename: str):
        if filename not in STATIC_FILES:
            return self.send_json(404, {"error": "no encontrado"})
        path = os.path.join(STATIC_DIR, filename)
        if not os.path.isfile(path):
            return self.send_json(404, {"error": "no encontrado"})
        with open(path, "rb") as f:
            body = f.read()
        ext = os.path.splitext(filename)[1]
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None, 400
        raw = self.rfile.read(length)
        try:
            return json.loads(raw), None
        except json.JSONDecodeError:
            return None, 400

    def query(self) -> dict:
        qs = urllib.parse.urlparse(self.path).query
        return {k: v[0] for k, v in urllib.parse.parse_qs(qs, keep_blank_values=True).items()}

    # --- proxy hacia la API oficial de Engram --------------------------------

    def upstream(self, method: str, path_query: str, payload=None):
        """Devuelve (status, json) o (None, None) si la API no está accesible."""
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self.config.engram_api + path_query,
                                     data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        token = os.environ.get("ENGRAM_HTTP_TOKEN")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"error": raw.decode(errors="replace")[:300]}
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            return None, None

    def proxy(self, method: str, path_query: str, payload=None):
        status, body = self.upstream(method, path_query, payload)
        if status is None:
            return self.send_json(502, {
                "error": "La API de Engram no está accesible en " + self.config.engram_api})
        return self.send_json(status, body if body is not None else {})

    # --- rutas ----------------------------------------------------------------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, q = parsed.path, self.query()

        if not path.startswith("/api/"):
            if path in ("/", "/index.html"):
                return self.send_static("index.html")
            if path.lstrip("/") in STATIC_FILES:
                return self.send_static(path.lstrip("/"))
            return self.send_json(404, {"error": "no encontrado"})

        if path == "/api/health":
            status, body = self.upstream("GET", "/health")
            if status is None:
                return self.send_json(502, {"ok": False, "error": "API de Engram no accesible"})
            return self.send_json(200, {"ok": status == 200, "engram": body})

        if path == "/api/system":
            return self.send_json(200, self.system_info())

        if path == "/api/doctor":
            return self.proxy("GET", "/doctor" + self._qs(q, ["project", "check"]))

        if path == "/api/stats":
            return self.proxy_optional(
                "stats", "/stats" + self._query(self._pick(q, ["project", "all_projects"])))

        if path == "/api/projects":
            status, body = self.upstream("GET", "/projects")
            if status is None:
                return self.send_json(502, {"error": "API de Engram no accesible"})
            if status != 200:
                return self.send_json(status, body)
            return self.send_json(200, {"projects": map_projects(body)})

        if path == "/api/conflicts":
            params = self._paging_params(q, default_limit=100, max_limit=500)
            params.update(self._pick(q, ["project", "all_projects", "status"]))
            return self.proxy_optional("conflicts", "/conflicts" + self._query(params))

        if path == "/api/conflicts/stats":
            return self.proxy_optional(
                "conflicts", "/conflicts/stats"
                + self._query(self._pick(q, ["project", "all_projects"])))

        if path == "/api/conflicts/deferred":
            params = self._paging_params(q, default_limit=100, max_limit=500)
            params.update(self._pick(q, ["project", "all_projects", "status"]))
            return self.proxy_optional("conflicts", "/conflicts/deferred" + self._query(params))

        if path == "/api/review":
            params = self._paging_params(q, default_limit=100, max_limit=500)
            params.update(self._pick(q, ["project", "all_projects"]))
            return self.proxy_optional("review", "/review" + self._query(params))

        if path == "/api/export":
            project = (q.get("project") or "").strip()
            if not project:
                return self.send_json(400, {"error": "Parámetro 'project' requerido"})
            return self.proxy_optional(
                "export", "/export" + self._query({"project": project}))

        m = re.fullmatch(r"/api/conflicts/(\d+)", path)
        if m:
            return self.proxy_optional("conflicts", f"/conflicts/{m.group(1)}", item=True)

        if path == "/api/observations":
            scope_params = self._scope_params(q)
            if not scope_params:
                return self.send_json(400, {
                    "error": "Parámetro 'project' requerido (o 'all_projects=true')"})
            global_scope = "all_projects" in scope_params
            limit = clamp_int(q.get("limit"), 1, MAX_LIMIT, DEFAULT_LIMIT)
            params = dict(scope_params, limit=str(limit))
            params.update(self._pick(q, ["type", "scope"]))
            status, body = self.upstream(
                "GET", "/observations" + self._query(params))
            if status is None:
                return self.send_json(502, {"error": "API de Engram no accesible"})
            if status != 200:
                return self.send_json(status, body)
            observations = body or []
            return self.send_json(200, {
                "project": "" if global_scope else scope_params["project"],
                "scope": "all" if global_scope else "project",
                "observations": observations,
                "truncated": len(observations) >= limit})

        if path == "/api/search":
            query = q.get("q", "").strip()
            if not query:
                return self.send_json(400, {"error": "Parámetro 'q' requerido"})
            limit = clamp_int(q.get("limit"), 1, 500, 100)
            params = {"q": query, "limit": str(limit)}
            params.update(self._pick(q, ["project", "all_projects", "type", "scope"]))
            status, body = self.upstream(
                "GET", "/search?" + urllib.parse.urlencode(params))
            if status is None:
                return self.send_json(502, {"error": "API de Engram no accesible"})
            if status != 200:
                return self.send_json(status, body)
            results = body or []
            return self.send_json(200, {"results": results,
                                        "truncated": len(results) >= limit})

        if path == "/api/sessions/recent":
            scope_params = self._scope_params(q)
            if not scope_params:
                return self.send_json(400, {
                    "error": "Parámetro 'project' requerido (o 'all_projects=true')"})
            limit = clamp_int(q.get("limit"), 1, 500, 100)
            params = dict(scope_params, limit=str(limit))
            status, body = self.upstream(
                "GET", "/sessions/recent" + self._query(params))
            if status is None:
                return self.send_json(502, {"error": "API de Engram no accesible"})
            if status != 200:
                return self.send_json(status, body)
            sessions = body or []
            return self.send_json(200, {
                "sessions": sessions,
                "scope": "all" if "all_projects" in scope_params else "project",
                "limit": limit,
                "truncated": len(sessions) >= limit})

        if path == "/api/prompts":
            scope_params = self._scope_params(q)
            if not scope_params:
                return self.send_json(400, {
                    "error": "Parámetro 'project' requerido (o 'all_projects=true')"})
            limit = clamp_int(q.get("limit"), 1, 500, 100)
            params = dict(scope_params, limit=str(limit))
            status, body = self.upstream(
                "GET", "/prompts/recent" + self._query(params))
            if status is None:
                return self.send_json(502, {"error": "API de Engram no accesible"})
            if status != 200:
                return self.send_json(status, body)
            prompts = body or []
            return self.send_json(200, {
                "prompts": prompts,
                "scope": "all" if "all_projects" in scope_params else "project",
                "limit": limit,
                "truncated": len(prompts) >= limit})

        if path == "/api/overview":
            return self.overview()

        m = re.fullmatch(r"/api/sessions/([^/]+)", path)
        if m:
            return self.proxy("GET", f"/sessions/{urllib.parse.quote(m.group(1))}")

        m = re.fullmatch(r"/api/observations/(\d+)", path)
        if m:
            return self.proxy("GET", f"/observations/{m.group(1)}")

        return self.send_json(404, {"error": "no encontrado"})

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        m = re.fullmatch(r"/api/observations/(\d+)", parsed.path)
        if not m:
            return self.send_json(404, {"error": "no encontrado"})
        payload, err = self.read_body()
        if err:
            return self.send_json(err, {"error": "Cuerpo JSON inválido"})
        expected_project = self._qs(self.query(), ["expected_project"])
        return self.proxy("PATCH", f"/observations/{m.group(1)}" + expected_project, payload)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/snapshots":
            # El cuerpo se ignora: el snapshot es siempre el export global.
            self.read_body()
            return self.create_snapshot()
        return self.send_json(404, {"error": "no encontrado"})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        q = self.query()

        m = re.fullmatch(r"/api/observations/(\d+)", parsed.path)
        if m:
            return self.delete_observation(m.group(1), q)

        m = re.fullmatch(r"/api/prompts/(\d+)", parsed.path)
        if m:
            return self.delete_permanent(f"/prompts/{m.group(1)}", q)

        m = re.fullmatch(r"/api/sessions/([^/]+)", parsed.path)
        if m:
            return self.delete_permanent(
                f"/sessions/{urllib.parse.quote(m.group(1))}", q)

        m = re.fullmatch(r"/api/projects/(.+)", parsed.path)
        if m:
            return self.delete_project(urllib.parse.unquote(m.group(1)), q)

        return self.send_json(404, {"error": "no encontrado"})

    # --- borrados -------------------------------------------------------------

    def delete_observation(self, obs_id: str, q: dict):
        """Soft por defecto; `hard=true` es irreversible y exige snapshot."""
        expected = (q.get("expected_project") or "").strip()
        if not expected:
            return self.send_json(400, {
                "error": "Parámetro 'expected_project' requerido: el motor exige la "
                         "comprobación de propiedad para borrar una observación"})
        hard, err = self._bool_param(q, "hard")
        if err:
            return self.send_json(400, {"error": err})
        if hard:
            problem = self._snapshot_problem(q.get("snapshot"))
            if problem:
                return self.send_json(403, {"error": problem})
        params = {"expected_project": expected}
        if hard:
            params["hard"] = "true"
        return self.proxy("DELETE", f"/observations/{obs_id}" + self._query(params))

    def delete_permanent(self, path_query: str, q: dict):
        """Prompts y sesiones: el motor solo los borra de forma permanente."""
        problem = self._snapshot_problem(q.get("snapshot"))
        if problem:
            return self.send_json(403, {"error": problem})
        return self.proxy("DELETE", path_query)

    def create_snapshot(self):
        """Export global del motor escrito a disco antes de un borrado irreversible."""
        status, body = self.upstream("GET", "/export?all_projects=true")
        if status is None:
            return self.send_json(502, {"error": "API de Engram no accesible"})
        if status != 200:
            return self.send_json(status, body if body is not None else {})
        directory = self.config.snapshot_dir()
        try:
            os.makedirs(directory, exist_ok=True)
        except OSError as e:
            return self.send_json(500, {
                "error": f"No se pudo crear el directorio de snapshots {directory}: {e}"})
        raw = json.dumps(body, ensure_ascii=False).encode()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        path = os.path.join(directory, f"engram-export-{stamp}.json")
        try:
            with open(path, "wb") as f:
                f.write(raw)
        except OSError as e:
            return self.send_json(500, {"error": f"No se pudo escribir {path}: {e}"})
        return self.send_json(200, {
            "path": path,
            "bytes": len(raw),
            "exported_at": (body or {}).get("exported_at"),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "max_age_seconds": SNAPSHOT_MAX_AGE_SECONDS,
        })

    def delete_project(self, name: str, q: dict):
        """Cascada de proyecto vía el CLI `engram delete project <name> [--hard]`.

        El motor no expone el borrado de proyecto por HTTP y el CLI soft
        también borra los prompts de forma permanente: ambos modos exigen
        un snapshot vigente. El nombre se valida contra el listado de
        proyectos del motor antes de ejecutar ningún subprocess.
        """
        status, body = self.upstream("GET", "/projects")
        if status is None:
            return self.send_json(502, {"error": "API de Engram no accesible"})
        if status != 200:
            return self.send_json(status, body if body is not None else {})
        known = {p.get("name") for p in map_projects(body)}
        if name not in known:
            return self.send_json(400, {
                "error": f"El proyecto '{name}' no aparece en el listado de "
                         "proyectos del motor: no se ejecuta la cascada"})
        hard, err = self._bool_param(q, "hard")
        if err:
            return self.send_json(400, {"error": err})
        problem = self._snapshot_problem(q.get("snapshot"))
        if problem:
            return self.send_json(403, {"error": problem})
        cmd = [self.config.engram_bin, "delete", "project", name]
        if hard:
            cmd.append("--hard")
        env = dict(os.environ, ENGRAM_DATA_DIR=self.config.data_dir)
        try:
            result = subprocess.run(cmd, env=env, cwd=self.config.data_dir,
                                    capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            return self.send_json(502, {
                "error": "El comando 'engram delete project' no terminó en 60 s: "
                         "no se sabe qué efectos parciales pudo dejar en el store; "
                         "no se declara éxito"})
        if result.returncode != 0:
            tail = (result.stderr or "").strip()[-CLI_ERROR_TAIL_MAX_CHARS:]
            return self.send_json(502, {
                "error": f"El comando 'engram delete project' terminó con código "
                         f"{result.returncode}: {tail}. No se sabe qué efectos "
                         f"parciales pudo dejar en el store; no se declara éxito"})
        output = (result.stdout or "").strip()
        counts = CLI_PROJECT_COUNTS.search(output)
        if not counts:
            return self.send_json(502, {
                "error": "El comando del motor terminó sin el formato esperado "
                         "'N observation(s), M prompt(s), K session(s)': "
                         "no se declara éxito",
                "cli_output": output[:CLI_OUTPUT_MAX_CHARS]})
        return self.send_json(200, {
            "project": name,
            "hard": hard,
            "observations": int(counts.group("observations")),
            "prompts": int(counts.group("prompts")),
            "sessions": int(counts.group("sessions")),
            "cli_output": output[:CLI_OUTPUT_MAX_CHARS]})

    def _bool_param(self, q: dict, name: str):
        raw = q.get(name)
        if raw is None or str(raw).strip() == "":
            return False, None
        value = str(raw).strip().lower()
        if value in ("true", "1"):
            return True, None
        if value in ("false", "0"):
            return False, None
        return False, f"Parámetro '{name}' inválido: usá true o false"

    def _snapshot_problem(self, raw) -> str:
        """Devuelve el motivo por el que un snapshot no habilita un borrado, o ''."""
        if not raw:
            return ("Falta el parámetro 'snapshot': un borrado definitivo exige un "
                    "snapshot del export generado por POST /api/snapshots")
        directory = os.path.realpath(self.config.snapshot_dir())
        path = os.path.realpath(os.path.abspath(str(raw)))
        if os.path.dirname(path) != directory:
            return "El 'snapshot' indicado no pertenece al directorio de snapshots del dashboard"
        if not os.path.isfile(path):
            return "El 'snapshot' indicado no existe: generá uno nuevo antes de borrar"
        age = time.time() - os.path.getmtime(path)
        if age > SNAPSHOT_MAX_AGE_SECONDS:
            return (f"El snapshot tiene {int(age)} s y el máximo es "
                    f"{SNAPSHOT_MAX_AGE_SECONDS} s: generá uno nuevo")
        try:
            with open(path, "rb") as f:
                head = f.read(4096)
        except OSError:
            return "El 'snapshot' indicado no se puede leer"
        if b'"exported_at"' not in head and b'"observations"' not in head:
            return "El 'snapshot' indicado no parece un export de Engram"
        return ""

    # --- agregados -------------------------------------------------------------

    def _qs(self, q: dict, allowed: list) -> str:
        keep = {k: v for k, v in q.items() if k in allowed and v}
        return ("?" + urllib.parse.urlencode(keep)) if keep else ""

    def _pick(self, q: dict, allowed: list) -> dict:
        return {k: v for k, v in q.items() if k in allowed and v}

    def _query(self, params: dict) -> str:
        return ("?" + urllib.parse.urlencode(params)) if params else ""

    def _paging_params(self, q: dict, default_limit: int, max_limit: int) -> dict:
        params = {"limit": str(clamp_int(q.get("limit"), 1, max_limit, default_limit))}
        if q.get("offset"):
            params["offset"] = str(clamp_int(q.get("offset"), 0, 1000000, 0))
        return params

    def _scope_params(self, q: dict) -> dict:
        """Ámbito de una lectura: global (`all_projects`) o un proyecto concreto."""
        if str(q.get("all_projects", "")).lower() in ("true", "1"):
            return {"all_projects": "true"}
        project = (q.get("project") or "").strip()
        return {"project": project} if project else {}

    def proxy_optional(self, surface: str, path_query: str, item: bool = False):
        """Superficie que puede no existir en el motor detectado.

        Un 404 en la ruta de colección significa que el motor no expone esa
        superficie; en una ruta de elemento, que el elemento no existe.
        """
        status, body = self.upstream("GET", path_query)
        if status is None:
            return self.send_json(502, {"error": "API de Engram no accesible"})
        if status == 404:
            if item:
                return self.send_json(404, body if body is not None else {"error": "no encontrado"})
            return self.send_json(404, {
                "error": f"El motor detectado no expone la superficie '{surface}'",
                "surface": surface})
        return self.send_json(status, body if body is not None else {})

    def system_info(self) -> dict:
        data_dir = self.config.data_dir
        info = {
            "engram_bin": self.config.engram_bin,
            "api_base": self.config.engram_api,
            "host": self.config.host,
            "port": self.config.port,
            "data_dir": data_dir,
            "db_path": os.path.join(data_dir, "engram.db"),
            "version": None,
            "status": "down",
            "verified_version": VERIFIED_ENGRAM_VERSION,
            "compatible": False,
        }
        status, body = self.upstream("GET", "/health")
        if status == 200 and body:
            info["version"] = body.get("version")
            info["status"] = body.get("status", "ok")
            info["compatible"] = info["version"] == VERIFIED_ENGRAM_VERSION
        return info

    def overview(self):
        status, health = self.upstream("GET", "/health")
        if status is None:
            return self.send_json(502, {"error": "API de Engram no accesible"})

        status, stats = self.upstream("GET", "/stats?all_projects=true")
        if status is None:
            return self.send_json(502, {"error": "API de Engram no accesible"})
        if status != 200:
            return self.send_json(status, stats)

        status, projects_body = self.upstream("GET", "/projects")
        if status is None:
            return self.send_json(502, {"error": "API de Engram no accesible"})
        if status != 200:
            return self.send_json(status, projects_body)
        projects = map_projects(projects_body)

        status, observations = self.upstream(
            "GET", f"/observations?all_projects=true&limit={OVERVIEW_LIMIT}")
        if status is None:
            return self.send_json(502, {"error": "API de Engram no accesible"})
        if status != 200:
            return self.send_json(status, observations)
        observations = observations or []

        by_type = {}
        d1 = d7 = d30 = 0
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        # Serie diaria: 30 días completos terminando hoy, en orden ascendente.
        # Los días sin actividad se declaran a cero en lugar de omitirse.
        by_day = {(now - timedelta(days=offset)).date().isoformat(): 0
                  for offset in range(ACTIVITY_DAYS - 1, -1, -1)}
        first_day = next(iter(by_day))
        last_seen = {}
        for o in observations:
            t = o.get("type") or "other"
            by_type[t] = by_type.get(t, 0) + 1
            created = (o.get("created_at") or "").replace("T", " ").rstrip("Z")
            try:
                dt = datetime.strptime(created, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            # Última señal de vida por proyecto (mismo recorrido, sin rutas nuevas).
            name = o.get("project") or ""
            seen = o.get("updated_at") or created
            if seen > last_seen.get(name, ""):
                last_seen[name] = seen
            days = (now - dt).total_seconds() / 86400
            if days <= 1:
                d1 += 1
            if days <= 7:
                d7 += 1
            if days <= 30:
                d30 += 1
            day = dt.date().isoformat()
            if day >= first_day:
                by_day[day] += 1
        recent = sorted(observations,
                        key=lambda o: o.get("created_at") or "", reverse=True)

        stats = stats or {}
        projects = [dict(p, last_activity=last_seen.get(p.get("name")))
                    for p in projects]
        return self.send_json(200, {
            "scope": "all",
            "loaded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "health": health,
            "stats": stats,
            "totals": {
                "observations": stats.get("total_observations", len(observations)),
                "sessions": stats.get("total_sessions", 0),
                "prompts": stats.get("total_prompts", 0),
                "projects": len(stats.get("projects") or projects),
            },
            "projects": projects,
            "activity": {"d1": d1, "d7": d7, "d30": d30,
                         "by_type": by_type, "by_day": by_day},
            "recent": recent[:12],
            "observations_loaded": len(observations),
            "truncated": len(observations) >= OVERVIEW_LIMIT,
        })


class DashServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: Config):
        self.config = config
        super().__init__((config.host, config.port), Handler)


def create_server(config: Config) -> DashServer:
    return DashServer(config)


def ensure_engram_api(engram_bin: str, api_base: str, data_dir: str):
    """Arranca `engram serve` si no hay ya una API viva; devuelve el Popen o None."""
    try:
        with urllib.request.urlopen(api_base + "/health", timeout=2) as r:
            if r.status == 200:
                return None
    except Exception:
        pass
    port = urllib.parse.urlparse(api_base).port or 7437
    env = dict(os.environ)
    if data_dir:
        env["ENGRAM_DATA_DIR"] = data_dir
    proc = subprocess.Popen([engram_bin, "serve", str(port)], env=env,
                            start_new_session=True)
    import time
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(api_base + "/health", timeout=2) as r:
                if r.status == 200:
                    return proc
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError(f"No se pudo arrancar {engram_bin} serve en {api_base}")


def main():
    import atexit
    import signal

    host = os.environ.get("ENGRAM_DASH_HOST", "127.0.0.1")
    port = int(os.environ.get("ENGRAM_DASH_PORT", "7438"))
    engram_bin = os.environ.get("ENGRAM_BIN") or shutil.which("engram") \
        or os.path.expanduser("~/.local/bin/engram")
    api_port = os.environ.get("ENGRAM_PORT", "7437")
    api_base = os.environ.get("ENGRAM_API", f"http://127.0.0.1:{api_port}")
    data_dir = os.environ.get("ENGRAM_DATA_DIR") or os.path.expanduser("~/.engram")

    proc = ensure_engram_api(engram_bin, api_base, data_dir)
    if proc:
        atexit.register(lambda: proc.poll() is None and proc.terminate())
        print(f"[engram-dashboard] API de Engram arrancada en {api_base} (pid {proc.pid})")
    else:
        print(f"[engram-dashboard] Reutilizando API de Engram existente en {api_base}")

    config = Config(host=host, port=port, engram_bin=engram_bin,
                    engram_api=api_base, data_dir=data_dir)
    httpd = create_server(config)

    def bye(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, bye)
    atexit.register(httpd.server_close)

    print(f"[engram-dashboard] Dashboard en http://{host}:{port} "
          f"(datos: {data_dir})")
    try:
        httpd.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
