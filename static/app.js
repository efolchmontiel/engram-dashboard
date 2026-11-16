/* Engram Dashboard local — SPA vanilla (sin build step, sin dependencias). */
"use strict";

/* --- utilidades ----------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/* Engram guarda timestamps UTC con formato "YYYY-MM-DD HH:MM:SS". */
function parseTs(s) {
  if (!s) return null;
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z"));
}

function fmtDT(s) {
  const d = parseTs(s);
  return d ? d.toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function rel(s) {
  const d = parseTs(s);
  if (!d) return "—";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return "ahora";
  if (sec < 3600) return `hace ${Math.round(sec / 60)} min`;
  if (sec < 86400) return `hace ${Math.round(sec / 3600)} h`;
  if (sec < 86400 * 30) return `hace ${Math.round(sec / 86400)} d`;
  return d.toLocaleDateString("es-ES", { dateStyle: "medium" });
}

/* --- markdown acotado ----------------------------------------------------- */

/* Se escapa primero y solo se aplican transformaciones de lista blanca
   (encabezados, listas, negrita, código y saltos): nada de HTML crudo. */
const HL = { term: "" };

function highlight(escaped) {
  if (!HL.term) return escaped;
  const needle = esc(HL.term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!needle) return escaped;
  return escaped.replace(new RegExp(needle, "gi"), (m) => `<mark>${m}</mark>`);
}

function mdInline(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

function mdBlock(src) {
  const out = [];
  let inList = false;
  for (const line of esc(src).split("\n")) {
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      if (!inList) { out.push('<ul class="md-list">'); inList = true; }
      out.push(`<li>${highlight(mdInline(item[1]))}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      const lvl = Math.min(3 + head[1].length, 6);
      out.push(`<h${lvl} class="md-head">${highlight(mdInline(head[2]))}</h${lvl}>`);
      continue;
    }
    out.push(highlight(mdInline(line)));
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

/* Texto plano corto para las vistas de lista (sin marcas de markdown). */
function mdPreview(src, max = 200) {
  const flat = String(src || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "· ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return highlight(esc(flat.slice(0, max)));
}

const KNOWN_TYPES = ["decision", "architecture", "bugfix", "config", "discovery",
  "learning", "pattern", "preference", "session_summary", "manual"];

/* Los tres valores de ámbito que acepta el PATCH del motor. */
const OBS_SCOPES = ["project", "personal", "global"];

/* Etiqueta real siempre; color por tipo conocido, neutro si no está catalogado. */
const badge = (type) => {
  const t = type || "other";
  const cls = KNOWN_TYPES.includes(t) ? `t-${esc(t)}` : "t-unknown";
  return `<span class="badge ${cls}">${esc(t)}</span>`;
};

const JUDGMENTS = {
  pending: "t-session_summary",
  judged: "t-discovery",
  orphaned: "t-bugfix",
};

const judgmentBadge = (status) => {
  const s = status || "pending";
  return `<span class="badge ${JUDGMENTS[s] || "t-unknown"}">${esc(s)}</span>`;
};

/* --- API ------------------------------------------------------------------ */

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      method: opts.method || "GET",
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw { status: 0, error: "No se pudo conectar con el dashboard backend." };
  }
  let data = null;
  try { data = await res.json(); } catch { /* no-json */ }
  if (!res.ok) {
    throw { status: res.status, error: (data && data.error) || `HTTP ${res.status}`,
            surface: data && data.surface };
  }
  return data;
}

/* --- estado ---------------------------------------------------------------- */

const ALL_PROJECTS = "";   /* valor del selector para el ámbito global */

const state = {
  project: localStorage.getItem("dash.project") ?? ALL_PROJECTS,
  q: "", type: "", session: "", order: "updated", limit: 1000,
  projects: [], health: null, stats: null, loadedAt: null,
  compatible: true,
  cStatus: "", cRelation: "", cOffset: 0,
  obsIndex: null, focusSearch: false,
};

/* Parámetros de ámbito: proyecto concreto o todos. */
function scopeQS(extra = {}) {
  const p = new URLSearchParams(extra);
  if (state.project) p.set("project", state.project);
  else p.set("all_projects", "true");
  return p;
}

function scopeLabel() {
  return state.project || "todos los proyectos";
}

/* --- toasts ----------------------------------------------------------------- */

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

/* --- foco ------------------------------------------------------------------- */

/* Contiene el foco dentro de un contenedor y lo devuelve al cerrar. */
function trapFocus(container) {
  const previous = document.activeElement;
  const focusables = () => $$(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    container,
  );
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener("keydown", onKey);
  container.setAttribute("tabindex", "-1");
  const first = focusables()[0] || container;
  first.focus();
  return () => {
    container.removeEventListener("keydown", onKey);
    if (previous && typeof previous.focus === "function") previous.focus();
  };
}

/* --- modal de confirmación --------------------------------------------------- */

let releaseModalFocus = null;

function confirmModal({ title, bodyHtml, confirmText, onConfirm }) {
  const backdrop = $("#modal-backdrop");
  $("#modal").innerHTML = `
    <h3>${esc(title)}</h3>
    <p>${bodyHtml}</p>
    <div class="actions">
      <button class="btn ghost" data-act="cancel">Cancelar</button>
      <button class="btn danger" data-act="confirm">${esc(confirmText)}</button>
    </div>`;
  backdrop.hidden = false;
  const close = () => {
    backdrop.hidden = true;
    if (releaseModalFocus) { releaseModalFocus(); releaseModalFocus = null; }
  };
  $('[data-act="cancel"]', $("#modal")).onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  $('[data-act="confirm"]', $("#modal")).onclick = async () => {
    close();
    try { await onConfirm(); } catch (err) { toast(err.error || "Error", "error"); }
  };
  releaseModalFocus = trapFocus($("#modal"));
}

/* --- drawer de detalle -------------------------------------------------------- */

let releaseDrawerFocus = null;

function openDrawer(html) {
  if (releaseDrawerFocus) { releaseDrawerFocus(); releaseDrawerFocus = null; }
  $("#drawer").innerHTML = html;
  $("#drawer").hidden = false;
  $("#drawer-backdrop").hidden = false;
  releaseDrawerFocus = trapFocus($("#drawer"));
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
  if (releaseDrawerFocus) { releaseDrawerFocus(); releaseDrawerFocus = null; }
}

$("#drawer-backdrop").addEventListener("click", closeDrawer);

/* --- observación: metadatos, copia y export ---------------------------------- */

function obsMeta(obs) {
  const rows = [
    ["id", obs.id], ["session", obs.session_id], ["project", obs.project],
    ["scope", obs.scope], ["topic_key", obs.topic_key || "—"],
    ["sync_id", obs.sync_id || "—"],
    ["revisiones", obs.revision_count], ["duplicados", obs.duplicate_count],
    ["creada", fmtDT(obs.created_at)], ["actualizada", fmtDT(obs.updated_at)],
    ["última vez vista", obs.last_seen_at ? fmtDT(obs.last_seen_at) : "—"],
  ];
  if (obs.review_after) rows.push(["revisión", fmtDT(obs.review_after)]);
  return `<dl class="meta-grid">${rows.map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copiado al portapapeles`, "ok");
  } catch {
    toast("No se pudo copiar (permiso del navegador)", "error");
  }
}

/* Exportación local: sin backend, Blob + descarga directa. */
function obsToMarkdown(obs) {
  const meta = [
    `- **id:** ${obs.id}`,
    `- **tipo:** ${obs.type || "—"}`,
    `- **proyecto:** ${obs.project || "—"}`,
    `- **sesión:** ${obs.session_id || "—"}`,
    `- **creada:** ${fmtDT(obs.created_at)}`,
    `- **actualizada:** ${fmtDT(obs.updated_at)}`,
    `- **revisiones:** ${obs.revision_count ?? "—"}`,
  ].join("\n");
  return `# ${obs.title}\n\n${meta}\n\n---\n\n${obs.content}\n`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function downloadObs(obs, fmt) {
  const slug = String(obs.title).toLowerCase().replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40) || "memoria";
  const base = `engram-${obs.id}-${slug}`;
  const blob = fmt === "md"
    ? new Blob([obsToMarkdown(obs)], { type: "text/markdown;charset=utf-8" })
    : new Blob([JSON.stringify(obs, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${base}.${fmt}`);
  toast(`Exportado ${base}.${fmt}`, "ok");
}

/* Export completo del proyecto, generado por el motor. */
async function downloadProjectExport(project) {
  try {
    const data = await api(`/api/export?project=${encodeURIComponent(project)}`);
    const stamp = (data.exported_at || "").slice(0, 19).replace(/[: ]/g, "-");
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      `engram-export-${project}-${stamp || "ahora"}.json`);
    toast(`Export de ${project} descargado`, "ok");
  } catch (err) {
    toast(err.error || "No se pudo exportar el proyecto", "error");
  }
}

/* --- observación: detalle, edición y enlace ---------------------------------- */

function obsHash(id) {
  return `#/memories/obs/${encodeURIComponent(id)}`;
}

async function openObservationById(id) {
  try {
    showObservation(await api(`/api/observations/${encodeURIComponent(id)}`));
  } catch (err) {
    toast(err.error || "No se pudo abrir la memoria", "error");
  }
}

/* Abre el detalle y deja la URL apuntando a la observación (sin re-render). */
function openObservationFromList(id) {
  if (!location.hash.startsWith(obsHash(0).slice(0, -1))) {
    history.pushState(null, "", obsHash(id));
  } else {
    history.replaceState(null, "", obsHash(id));
  }
  openObservationById(id);
}

function showObservation(obs) {
  openDrawer(`
    <div class="drawer-head">
      <div>
        ${badge(obs.type)}
        <h3 style="margin-top:8px">${esc(obs.title)}</h3>
      </div>
      <button class="btn ghost icon" data-act="close" title="Cerrar">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10M17 7 7 17"/></g></svg>
      </button>
    </div>
    <div class="drawer-body">
      <div class="content">${mdBlock(obs.content)}</div>
      ${obsMeta(obs)}
      <div class="drawer-actions">
        <button class="btn" data-act="edit">Editar</button>
        <button class="btn" data-act="hide">Ocultar (soft)</button>
        <button class="btn danger" data-act="delete-hard">Borrar definitivamente (hard)</button>
      </div>
      <div class="drawer-actions">
        <button class="btn ghost" data-act="copy-id">Copy ID</button>
        <button class="btn ghost" data-act="copy-content">Copy content</button>
        <button class="btn ghost" data-act="export-md">Markdown</button>
        <button class="btn ghost" data-act="export-json">JSON</button>
      </div>
    </div>`);

  $('[data-act="close"]', $("#drawer")).onclick = closeDrawer;

  $('[data-act="edit"]', $("#drawer")).onclick = () => editObservation(obs);
  $('[data-act="copy-id"]', $("#drawer")).onclick = () => copyText(String(obs.id), "ID");
  $('[data-act="copy-content"]', $("#drawer")).onclick = () => copyText(obs.content, "Contenido");
  $('[data-act="export-md"]', $("#drawer")).onclick = () => downloadObs(obs, "md");
  $('[data-act="export-json"]', $("#drawer")).onclick = () => downloadObs(obs, "json");
  $('[data-act="hide"]', $("#drawer")).onclick = () => confirmModal({
    title: "¿Ocultar esta memoria?",
    bodyHtml: `<b>${esc(obs.title)}</b><br><br>Se realiza un borrado <b>soft</b>: la observación queda oculta en el listado y no vuelve a cargarse en el panel.`,
    confirmText: "Ocultar",
    onConfirm: async () => {
      await api(`/api/observations/${obs.id}?expected_project=${encodeURIComponent(obs.project)}`, { method: "DELETE" });
      toast("Memoria eliminada (soft)", "ok");
      state.obsIndex = null;
      closeDrawer();
      route();
    },
  });
  $('[data-act="delete-hard"]', $("#drawer")).onclick = () => hardDeleteObservation(obs);
}

function editObservation(obs) {
  const types = [...new Set([...KNOWN_TYPES, obs.type])].filter(Boolean);
  openDrawer(`
    <div class="drawer-head">
      <h3>Editar memoria <span class="faint mono">#${esc(obs.id)}</span></h3>
      <button class="btn ghost icon" data-act="close" title="Cerrar">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10M17 7 7 17"/></g></svg>
      </button>
    </div>
    <div class="drawer-body">
      <form class="drawer-form" id="edit-form">
        <div><label>Título</label>
          <input type="text" name="title" value="${esc(obs.title)}" required></div>
        <div class="row">
          <div><label>Tipo</label>
            <select name="type">${types.map((t) =>
              `<option value="${esc(t)}" ${t === obs.type ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
          <div><label>Ámbito</label>
            <select name="scope">${OBS_SCOPES.map((s) =>
              `<option value="${esc(s)}" ${s === (obs.scope || "project") ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
        </div>
        <div><label>Clave temática (topic_key)</label>
          <input type="text" name="topic_key" value="${esc(obs.topic_key || "")}" spellcheck="false">
          <div class="form-hint">Déjalo vacío para borrar la clave temática.</div></div>
        <div><label>Contenido</label>
          <textarea name="content" required>${esc(obs.content)}</textarea></div>
        <div class="drawer-actions">
          <button type="button" class="btn ghost" data-act="back">Cancelar</button>
          <button type="submit" class="btn primary">Guardar cambios</button>
        </div>
      </form>
    </div>`);

  $('[data-act="close"]', $("#drawer")).onclick = () => showObservation(obs);
  $('[data-act="back"]', $("#drawer")).onclick = () => showObservation(obs);
  $("#edit-form").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/api/observations/${obs.id}?expected_project=${encodeURIComponent(obs.project)}`, {
        method: "PATCH",
        body: {
          title: fd.get("title").trim(),
          type: fd.get("type"),
          content: fd.get("content"),
          scope: fd.get("scope"),
          /* Vacío significa borrar el campo en el motor: null, nunca "". */
          /* El motor limpia la clave con cadena vacía y rechaza null
             ("at least one field is required"), así que no se manda null. */
          topic_key: String(fd.get("topic_key") || "").trim(),
        },
      });
      toast("Memoria actualizada", "ok");
      state.obsIndex = null;
      closeDrawer();
      route();
    } catch (err) {
      toast(err.error || "No se pudo guardar", "error");
    }
  };
}

/* --- vistas ----------------------------------------------------------------- */

function banner(err) {
  return `<div class="banner">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 3 20h18Z"/><path d="M12 9v5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></g></svg>
    <div>${esc(err.error || "Error inesperado")}</div>
  </div>`;
}

/* Motor sin la superficie requerida: se avisa y el resto sigue operativo. */
function surfaceGap(err, what) {
  return `<div class="banner warn">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 3 20h18Z"/><path d="M12 9v5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></g></svg>
    <div><b>${esc(what)} no disponible</b><br>${esc(err.error || "La ruta no existe en el motor detectado")}</div>
  </div>`;
}

function loading(label = "Cargando…") {
  return `<div class="skeleton">${esc(label)}</div>`;
}

function empty(title, hint) {
  return `<div class="empty"><strong>${esc(title)}</strong>${esc(hint)}</div>`;
}

function windowNotice(shown, truncated, total) {
  if (!truncated) {
    return `<div class="notice muted">Mostrando <b>${shown}</b> memorias de ${esc(scopeLabel())}.</div>`;
  }
  return `<div class="notice">
    El ámbito tiene más memorias: se cargaron <b>${shown}</b>${total ? ` de ~${total}` : ""} (límite de la petición).
    <button class="btn" id="load-all">Cargar todo el ámbito</button>
  </div>`;
}

/* --- Overview: la cinta solar ------------------------------------------------ */

/* Un mismo color por tipo en la banda, el encabezado del tipo y el ledger.
   Paleta fija del sistema; los tipos no catalogados caen al gris de "otros". */
const TYPE_HUE = {
  session_summary: "#ea1889", discovery: "#34d399", bugfix: "#f87171",
  decision: "#a78bfa", config: "#38bdf8", architecture: "#fbbf24",
  preference: "#f472b6", pattern: "#a3e635", manual: "#94a3b8", otros: "#52525b",
};
const typeColor = (t) => TYPE_HUE[t] || "#52525b";

const pct = (n, d) => (d ? (n * 100) / d : 0);
const fmtPct = (n, d) => (d ? `${pct(n, d).toFixed(1).replace(/\.0$/, "")}%` : "—");

/* El semicírculo se reparte entre un número acotado de cuñas para que la
   etiqueta horizontal siga cabiendo: los tipos restantes se agrupan en una
   única cuña "otros", sin perder el desglose, que vive en el aria-label.
   Misma regla de acotado (9 + otros) que tenía el radial. */
const SOLAR_MAX = 9;

/* Geometría de la banda elíptica: centro (620, 300), radios exteriores
   (600, 252) e interiores (322, 104); las cuñas van de 180° a 360°, cada una
   con un pequeño hueco angular para que las vecinas nunca se toquen. */
const SOLAR_GEO = {
  cx: 620, cy: 300, rxo: 600, ryo: 252, rxi: 322, ryi: 104,
  gap: 0.8, labelRx: 462, labelRy: 178, minLabelDeg: 15,
};

function solarPt(rx, ry, deg) {
  const a = (deg * Math.PI) / 180;
  return [SOLAR_GEO.cx + rx * Math.cos(a), SOLAR_GEO.cy + ry * Math.sin(a)];
}

/* Sector anular real: dos arcos elípticos y dos rectas, nunca stroke-dasharray. */
function solarSector(a0, a1) {
  const f = (n) => n.toFixed(2);
  const [x0, y0] = solarPt(SOLAR_GEO.rxo, SOLAR_GEO.ryo, a0);
  const [x1, y1] = solarPt(SOLAR_GEO.rxo, SOLAR_GEO.ryo, a1);
  const [x2, y2] = solarPt(SOLAR_GEO.rxi, SOLAR_GEO.ryi, a1);
  const [x3, y3] = solarPt(SOLAR_GEO.rxi, SOLAR_GEO.ryi, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${f(x0)} ${f(y0)}A${SOLAR_GEO.rxo} ${SOLAR_GEO.ryo} 0 ${large} 1 ${f(x1)} ${f(y1)}` +
    `L${f(x2)} ${f(y2)}A${SOLAR_GEO.rxi} ${SOLAR_GEO.ryi} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

/* Reparto en cuñas: tipos ordenados por peso, cola agrupada en "otros". */
function solarBuckets(byType) {
  const all = Object.entries(byType || {}).sort((a, b) => b[1] - a[1]);
  const head = all.slice(0, SOLAR_MAX - (all.length > SOLAR_MAX ? 1 : 0));
  const tail = all.slice(head.length);
  const wedges = tail.length
    ? [...head, ["otros", tail.reduce((acc, [, n]) => acc + n, 0)]]
    : all;
  return { wedges, tail: tail.map(([t]) => t), all };
}

/* Estado de la cinta: la selección vive entre refrescos; el modelo alimenta
   el hover (nombre y conteo al hueco) y el ledger de "otros". */
let solarSelected = "";
let solarModel = { total: 0, wedges: [], tail: [], loaded: 0, scopeTotal: 0 };

/* Control de ventana: la API no da desglose por tipo por ventana, así que la
   banda muestra el agregado real del ámbito cargado y el control queda
   visual, como en la referencia. */
function solarWindows() {
  return `<div class="windows" role="group" aria-label="Ventana de tiempo">
    <button data-w="24h">24 h</button><button data-w="7d">7 d</button>
    <button data-w="30d">30 d</button><button class="on" data-w="todo">todo</button>
  </div>`;
}

function renderSolar(byType, total, selected) {
  const { wedges, all } = solarBuckets(byType);
  const breakdown = all.map(([t, c]) => `${t} ${c}`).join(", ") || "sin tipos";
  const hole = `<div class="solar-hole">
      <div class="num" data-hole-num>${total}</div>
      <div class="unit" data-hole-unit>${esc(scopeLabel())}</div>
    </div>`;
  if (!wedges.length) {
    return `<div class="solar">
      <svg class="band" viewBox="0 0 1240 300" role="img" aria-label="Sin observaciones activas en el ámbito."></svg>
      ${hole}
      ${solarWindows()}
    </div>`;
  }
  const n = wedges.length;
  const usable = 180 - n * SOLAR_GEO.gap;
  let a = 180;
  const parts = [];
  for (const [type, count] of wedges) {
    const span = total ? (count / total) * usable : 0;
    const a0 = a + SOLAR_GEO.gap / 2;
    const a1 = a + span + SOLAR_GEO.gap / 2;
    const on = type === selected;
    const color = typeColor(type);
    const name = type.replace(/_/g, " ");
    parts.push(`<path class="wedge${on ? " on" : ""}" data-type="${esc(type)}" d="${solarSector(a0, a1)}"
      fill="${color}" fill-opacity="${on ? "0.92" : "0.34"}" stroke="${color}" stroke-opacity="0.55" stroke-width="0.8"
      role="button" tabindex="0" aria-pressed="${on}"
      aria-label="${esc(name)}: ${count} observaciones, ${fmtPct(count, total)} del total"/>`);
    /* Etiqueta horizontal solo donde la cuña tiene ancho para sostenerla; las
       angostas se identifican al pasar el puntero o el foco, que escriben
       nombre y conteo en el hueco. */
    if (span >= SOLAR_GEO.minLabelDeg) {
      const mid = (a0 + a1) / 2;
      const [lx, ly] = solarPt(SOLAR_GEO.labelRx, SOLAR_GEO.labelRy, mid);
      parts.push(`<text class="wlabel" x="${lx.toFixed(2)}" y="${ly.toFixed(2)}"
        text-anchor="middle" dominant-baseline="middle">${esc(name)} <tspan class="wcount">${count}</tspan></text>`);
    }
    a += span;
  }
  return `<div class="solar">
    <svg class="band" viewBox="0 0 1240 300" role="img"
      aria-label="Distribución de ${total} observaciones en ${all.length} tipos. Cada cuña es un tipo y actúa como pestaña. ${breakdown}.">
      ${parts.join("")}
    </svg>
    ${hole}
    ${solarWindows()}
  </div>`;
}

/* Encabezado del tipo seleccionado: swatch en su tono, nombre y la línea de
   datos con conteo, cuota y la ventana realmente cargada. */
function renderTypehead(type, count, total, loaded, scopeTotal) {
  return `<div class="typehead">
    <span class="swatch" style="background:${typeColor(type)}"></span>
    <div>
      <h1>${esc(type.replace(/_/g, " "))}</h1>
      <div class="fact"><b>${count}</b> observaciones · <b>${fmtPct(count, total)}</b> del total · ventana cargada ${loaded} de ${scopeTotal}</div>
    </div>
  </div>`;
}

/* Ledger del tipo seleccionado: hairlines con hora, título, preview y meta.
   "otros" no existe como tipo en el motor: se pide el ámbito y se filtra por
   los tipos agrupados en la cuña. */
const solarRow = (o) => `
  <div class="lrow" data-obs-id="${o.id}">
    <span class="h">${esc(rel(o.created_at))}</span>
    <div>
      <div class="t">${esc(o.title)}</div>
      <div class="p">${mdPreview(o.content, 160)}</div>
      <div class="meta">${esc(o.project || "—")} · ${esc(o.topic_key || "—")}</div>
    </div>
    <span class="tpill" style="--c:${typeColor(o.type)}">${esc(String(o.type || "otro").replace(/_/g, " "))}</span>
    <span class="when" title="${esc(fmtDT(o.updated_at))}">${esc(rel(o.updated_at))}</span>
  </div>`;

async function fillSolarLedger(view, type) {
  const host = $("#solar-ledger");
  if (!host) return;
  host.innerHTML = loading();
  try {
    const qs = scopeQS({ limit: 1000 });
    if (type !== "otros") qs.set("type", type);
    const data = await api(`/api/observations?${qs}`);
    let items = data.observations || [];
    if (type === "otros") items = items.filter((o) => solarModel.tail.includes(o.type || "other"));
    items = items
      .sort((x, y) => String(y.updated_at || "").localeCompare(String(x.updated_at || "")))
      .slice(0, 100);
    if (!items.length) {
      host.innerHTML = empty("Sin memorias", `No hay memorias de tipo ${esc(type.replace(/_/g, " "))} en ${esc(scopeLabel())}.`);
      return;
    }
    host.innerHTML = `<div class="ledger">${items.map(solarRow).join("")}</div>`;
    host.querySelectorAll("[data-obs-id]").forEach((el) => {
      el.onclick = () => openObservationFromList(el.dataset.obsId);
    });
  } catch (err) {
    host.innerHTML = banner(err);
  }
}

/* --- Overview ---------------------------------------------------------------- */

async function viewOverview(view) {
  view.innerHTML = loading();
  HL.term = "";
  showProjectSelect(false);
  try {
    const data = await api("/api/overview");
    state.health = data.health;
    state.stats = data.stats;
    state.projects = data.projects;
    state.loadedAt = data.loaded_at;
    setApiStatus(data.health.status === "ok", data.health.version, state.compatible);

    const t = data.totals;
    const a = data.activity;
    const loaded = data.observations_loaded || 0;
    const { wedges, tail } = solarBuckets(a.by_type);
    solarModel = { total: loaded, wedges, tail, loaded, scopeTotal: t.observations };
    if (!wedges.some(([ty]) => ty === solarSelected)) {
      solarSelected = wedges.length ? wedges[0][0] : "";
    }

    setPulses([
      `<span class="pill ${data.health.status === "ok" ? "ok" : "warn"}">
        <i class="dot ${data.health.status === "ok" ? "ok" : "down"}"></i>API ${esc(data.health.version || "?")}</span>`,
      `<span class="pill"><b>${a.d1}</b>&nbsp;mem 24 h</span>`,
      data.truncated ? `<span class="pill warn">ventana ${loaded}/${t.observations}</span>` : "",
      state.compatible ? "" : `<span class="pill warn">motor sin verificar</span>`,
      `<span class="pill">carga ${esc((data.loaded_at || "").slice(11, 19))}</span>`,
    ]);

    /* Sin tiles ni carriles: los contadores globales viven en la cinta del pie
       y el detalle por tipo vive en el encabezado y el ledger de la banda. */
    setTicker([
      ["observaciones", t.observations], ["sesiones", t.sessions],
      ["proyectos", t.projects], ["tipos", wedges.length],
      ["24 h", a.d1], ["7 d", a.d7], ["30 d", a.d30],
      ["cargadas", loaded], ["cargado", rel(data.loaded_at)],
    ]);

    const sel = wedges.find(([ty]) => ty === solarSelected) || ["", 0];
    view.innerHTML = `
      ${renderSolar(a.by_type, loaded, solarSelected)}
      ${wedges.length ? renderTypehead(sel[0], sel[1], loaded, loaded, t.observations) : ""}
      <div id="solar-ledger"></div>`;

    wireSolar(view);
    if (!wedges.length) {
      $("#solar-ledger").innerHTML = empty("Sin observaciones", "Engram todavía no tiene memoria en este ámbito.");
    } else {
      await fillSolarLedger(view, solarSelected);
    }
  } catch (err) {
    setApiStatus(false);
    view.innerHTML = banner(err);
  }
}

const obsCard = (o) => `
  <div class="tl-item" data-obs-id="${o.id}">
    <div class="tl-meta">${badge(o.type)}<span class="tl-time">${rel(o.created_at)}</span>
      ${o.project ? `<span class="faint mono">${esc(o.project)}</span>` : ""}</div>
    <div class="tl-title">${esc(o.title)}</div>
  </div>`;

function wireObsCards(root) {
  root.querySelectorAll("[data-obs-id]").forEach((el) => {
    el.onclick = () => openObservationFromList(el.dataset.obsId);
  });
}

/* Hover y foco escriben nombre y conteo en el hueco; al salir vuelve el
   agregado del ámbito. El clic (o Enter/Espacio) selecciona el tipo. */
function wireSolar(view) {
  const holeNum = $("[data-hole-num]", view);
  const holeUnit = $("[data-hole-unit]", view);
  const showScope = () => {
    if (!holeNum || !holeUnit) return;
    holeNum.textContent = solarModel.total;
    holeUnit.textContent = scopeLabel();
  };
  const showWedge = (type) => {
    const w = solarModel.wedges.find(([t]) => t === type);
    if (!w || !holeNum || !holeUnit) return;
    holeNum.textContent = w[1];
    holeUnit.textContent = type.replace(/_/g, " ");
  };
  view.querySelectorAll(".wedge").forEach((w) => {
    const type = w.dataset.type;
    const hot = () => w.setAttribute("fill-opacity", w.classList.contains("on") ? "0.92" : "0.72");
    const rest = () => w.setAttribute("fill-opacity", w.classList.contains("on") ? "0.92" : "0.34");
    w.addEventListener("mouseenter", () => { hot(); showWedge(type); });
    w.addEventListener("mouseleave", () => { rest(); showScope(); });
    w.addEventListener("focus", () => { hot(); showWedge(type); });
    w.addEventListener("blur", () => { rest(); showScope(); });
    w.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectSolarType(view, type); }
    });
    w.addEventListener("click", () => selectSolarType(view, type));
  });
  /* Ventana visual: sin desglose por tipo por ventana en la API. */
  const win = view.querySelectorAll(".windows button");
  win.forEach((b) => {
    b.addEventListener("click", () => {
      win.forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  showScope();
}

/* Selección: repinta cuñas, encabezado y ledger sin cambiar de ruta. */
function selectSolarType(view, type) {
  solarSelected = type;
  const w = solarModel.wedges.find(([t]) => t === type) || ["", 0];
  view.querySelectorAll(".wedge").forEach((p) => {
    const on = p.dataset.type === type;
    p.classList.toggle("on", on);
    p.setAttribute("aria-pressed", String(on));
    p.setAttribute("fill-opacity", on ? "0.92" : "0.34");
  });
  const head = view.querySelector(".typehead");
  if (head) {
    $(".swatch", head).style.background = typeColor(type);
    $("h1", head).textContent = type.replace(/_/g, " ");
    $(".fact", head).innerHTML =
      `<b>${w[1]}</b> observaciones · <b>${fmtPct(w[1], solarModel.total)}</b> del total · ventana cargada ${solarModel.loaded} de ${solarModel.scopeTotal}`;
  }
  fillSolarLedger(view, type);
}

/* El radar no gira con la pestaña oculta ni con movimiento reducido. Al volver
   a ser visible se sondea la salud de inmediato, sin esperar al siguiente tick. */
document.addEventListener("visibilitychange", () => {
  document.body.dataset.hidden = document.hidden ? "1" : "";
  if (!document.hidden) pollHealth();
});

/* --- Memories ------------------------------------------------------------------ */

const PAGE = 50;
let memReqSeq = 0;
let memData = { items: [], truncated: false };

function sortItems(items, order) {
  const s = [...items];
  if (order === "title") return s.sort((a, b) => String(a.title).localeCompare(String(b.title), "es"));
  const key = order === "created" ? "created_at" : "updated_at";
  return s.sort((a, b) => String(b[key] || "").localeCompare(String(a[key] || "")));
}

async function viewMemories(view) {
  showProjectSelect(true);
  HL.term = state.q;
  view.innerHTML = `
    <div class="toolbar">
      <div class="searchbox">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></g></svg>
        <input type="search" id="q" placeholder="Buscar con FTS de Engram…" value="${esc(state.q)}">
      </div>
      <select id="type-sel"></select>
      <input type="search" id="session-q" list="session-list" autocomplete="off"
             placeholder="Filtrar por sesión…" value="${esc(state.session)}">
      <datalist id="session-list"></datalist>
      <select id="order-sel">
        <option value="updated">Orden: actualización</option>
        <option value="created">Orden: creación</option>
        <option value="title">Orden: título</option>
      </select>
    </div>
    <div id="type-chips" class="chips"></div>
    <div id="mem-results">${loading()}</div>`;

  $("#q").oninput = debounce((e) => {
    state.q = e.target.value.trim();
    HL.term = state.q;
    fillMemResults();
  }, 300);
  $("#type-sel").onchange = (e) => { state.type = e.target.value; fillMemResults(); };
  $("#session-q").oninput = debounce((e) => { state.session = e.target.value.trim(); fillMemResults(); }, 250);
  const order = $("#order-sel");
  order.value = state.order;
  order.onchange = (e) => { state.order = e.target.value; renderMemResults(); };

  await Promise.all([fillMemResults(), fillSessionList()]);
  if (state.focusSearch) {
    state.focusSearch = false;
    const q = $("#q");
    if (q) { q.focus(); q.select(); }
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* Datalist: localizar una sesión por id sin recorrer una lista completa. */
async function fillSessionList() {
  const list = $("#session-list");
  if (!list) return;
  list.innerHTML = "";
  try {
    const { sessions } = await api(`/api/sessions/recent?${scopeQS({ limit: 200 }).toString()}`);
    list.innerHTML = sessions.map((s) =>
      `<option value="${esc(s.id)}" label="${esc(s.id)} · ${s.observation_count} obs"></option>`).join("");
  } catch { /* sin sesiones */ }
}

async function fillMemResults() {
  const box = $("#mem-results");
  if (!box) return;
  const seq = ++memReqSeq;
  const stale = () => seq !== memReqSeq || !$("#mem-results");
  box.innerHTML = loading();
  try {
    let items, truncated;
    if (state.q) {
      const qs = scopeQS({ q: state.q, limit: 200 });
      if (state.type) qs.set("type", state.type);
      const data = await api(`/api/search?${qs}`);
      items = data.results;
      truncated = data.truncated;
    } else {
      const qs = scopeQS({ limit: state.limit });
      if (state.type) qs.set("type", state.type);
      const data = await api(`/api/observations?${qs}`);
      items = data.observations;
      truncated = data.truncated;
    }
    if (stale()) return;

    /* Chips por tipo real presente en el conjunto cargado (con su cuenta). */
    const typeCounts = {};
    for (const o of items) {
      const t = o.type || "other";
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    const chipsBox = $("#type-chips");
    if (chipsBox) {
      const entries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
      chipsBox.innerHTML = entries.length ? entries.map(([t, n]) => `
        <button class="chip ${t === state.type ? "active" : ""}" data-type="${esc(t)}">
          ${esc(t)} <span class="mono">${n}</span>
        </button>`).join("") : "";
      chipsBox.querySelectorAll(".chip").forEach((c) => {
        c.onclick = () => {
          state.type = state.type === c.dataset.type ? "" : c.dataset.type;
          const sel = $("#type-sel");
          if (sel) sel.value = state.type;
          fillMemResults();
        };
      });
    }

    const types = [...new Set(items.map((o) => o.type).concat(KNOWN_TYPES))].filter(Boolean).sort();
    const typeSel = $("#type-sel");
    if (typeSel) {
      typeSel.innerHTML = `<option value="">Todos los tipos</option>` +
        types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
      typeSel.value = state.type;
    }

    if (state.type) items = items.filter((o) => o.type === state.type);
    if (state.session) {
      const needle = state.session;
      items = items.filter((o) => o.session_id === needle || String(o.session_id).includes(needle));
    }

    memData = { items, truncated };
    renderMemResults();
  } catch (err) {
    box.innerHTML = banner(err);
  }
}

function renderMemResults() {
  const box = $("#mem-results");
  if (!box) return;
  const items = sortItems(memData.items, state.order);
  const global = !state.project;
  if (!items.length) {
    const hasQuery = state.q || state.type || state.session;
    box.innerHTML = hasQuery
      ? empty("Sin coincidencias", "Ninguna memoria cumple la búsqueda y los filtros actuales.")
      : empty("Sin memorias", `El ámbito ${scopeLabel()} no tiene memorias activas.`);
    return;
  }
  const total = state.project
    ? (state.projects.find((p) => p.name === state.project) || {}).observations
    : (state.stats || {}).total_observations;
  let shown = 0;
  const draw = () => {
    const slice = items.slice(0, shown + PAGE);
    shown = slice.length;
    box.innerHTML = `
      ${windowNotice(items.length, memData.truncated, total)}
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th style="width:110px">Tipo</th><th>Memoria</th>
            ${global ? `<th style="width:130px">Proyecto</th>` : ""}
            <th style="width:180px">Sesión</th><th style="width:120px">Actualizada</th>
          </tr></thead>
          <tbody>
            ${slice.map((o) => `
              <tr data-obs-id="${o.id}">
                <td>${badge(o.type)}</td>
                <td><div class="title">${esc(o.title)}</div>
                    ${o.topic_key ? `<div class="topic-key mono faint">${esc(o.topic_key)}</div>` : ""}
                    <div class="preview">${mdPreview(o.content, 220)}</div></td>
                ${global ? `<td class="mono muted" title="${esc(o.project)}"><div class="cell-cut">${esc(o.project)}</div></td>` : ""}
                <td class="mono muted"><div class="cell-cut" title="${esc(o.session_id)}">${esc(o.session_id)}</div></td>
                <td class="muted" title="${esc(fmtDT(o.updated_at))}">${rel(o.updated_at)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      ${shown < items.length
        ? `<div style="text-align:center;margin-top:14px"><button class="btn" id="more-btn">Mostrar más (${items.length - shown} restantes)</button></div>`
        : ""}`;
    box.querySelectorAll("tr[data-obs-id]").forEach((tr) => {
      tr.onclick = () => openObservationFromList(tr.dataset.obsId);
    });
    const more = $("#more-btn");
    if (more) more.onclick = draw;
    const all = $("#load-all");
    if (all) all.onclick = () => {
      state.limit = 50000;
      fillMemResults();
    };
  };
  draw();
}

/* --- Sessions --------------------------------------------------------------------- */

async function viewSessions(view) {
  showProjectSelect(true);
  HL.term = "";
  view.innerHTML = loading();
  try {
    const { sessions } = await api(`/api/sessions/recent?${scopeQS({ limit: 200 }).toString()}`);
    if (!sessions.length) {
      view.innerHTML = empty("Sin sesiones", `No hay sesiones registradas en ${scopeLabel()}.`);
      return;
    }
    const global = !state.project;
    view.innerHTML = `
      ${sessions.length >= 200 ? `<div class="notice">Se listan las <b>200</b> sesiones más recientes; acota el ámbito a un proyecto para ver el resto.</div>` : ""}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Sesión</th>
            ${global ? `<th style="width:150px">Proyecto</th>` : ""}
            <th style="width:140px">Memorias</th><th style="width:180px">Inicio</th><th style="width:110px"></th></tr></thead>
          <tbody>
            ${sessions.map((s) => `
              <tr data-session="${esc(s.id)}">
                <td class="mono"><div class="cell-cut" title="${esc(s.id)}">${esc(s.id)}</div></td>
                ${global ? `<td class="mono muted">${esc(s.project)}</td>` : ""}
                <td><b class="mono">${s.observation_count}</b> <span class="faint">obs</span></td>
                <td class="muted" title="${esc(fmtDT(s.started_at))}">${rel(s.started_at)}</td>
                <td class="actions-cell">${s.observation_count === 0
                  ? `<button class="btn danger sm" data-del-session="${esc(s.id)}" title="Borrar la sesión vacía">Eliminar</button>`
                  : ""}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
    view.querySelectorAll("tr[data-session]").forEach((tr) => {
      tr.onclick = () => { location.hash = `#/sessions/${encodeURIComponent(tr.dataset.session)}`; };
    });
    /* Solo sesiones vacías: el botón nunca debe terminar abriendo el detalle. */
    view.querySelectorAll("button[data-del-session]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const s = sessions.find((x) => String(x.id) === btn.dataset.delSession);
        if (s) deleteEmptySessionFlow(s);
      };
    });
  } catch (err) {
    view.innerHTML = banner(err);
  }
}

async function viewSessionDetail(view, id) {
  showProjectSelect(false);
  HL.term = "";
  view.innerHTML = loading();
  try {
    const session = await api(`/api/sessions/${encodeURIComponent(id)}`);
    const { observations } = await api(
      `/api/observations?project=${encodeURIComponent(session.project)}&limit=50000`);
    const mine = observations
      .filter((o) => o.session_id === session.id)
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    view.innerHTML = `
      <a href="#/sessions" class="muted back">← Sessions</a>
      <div class="card" style="margin:12px 0 20px">
        <h3>Sesión</h3>
        <dl class="kv">
          <dt>id</dt><dd>${esc(session.id)}</dd>
          <dt>proyecto</dt><dd>${esc(session.project)}</dd>
          <dt>directorio</dt><dd>${esc(session.directory)}</dd>
          <dt>inicio</dt><dd>${fmtDT(session.started_at)}</dd>
          ${session.ended_at ? `<dt>fin</dt><dd>${fmtDT(session.ended_at)}</dd>` : ""}
          ${session.summary ? `<dt>resumen</dt><dd style="font-family:var(--sans)">${esc(session.summary)}</dd>` : ""}
        </dl>
      </div>
      <div class="card">
        <h3>Timeline · ${mine.length} memorias</h3>
        ${mine.length ? `<div class="timeline">${mine.map(obsCard).join("")}</div>`
          : `<div class="empty"><strong>Sin observaciones</strong>Esta sesión no tiene memorias activas.</div>`}
      </div>`;
    wireObsCards(view);
  } catch (err) {
    view.innerHTML = banner(err);
  }
}

/* --- Projects ------------------------------------------------------------------------ */

async function viewProjects(view) {
  showProjectSelect(false);
  HL.term = "";
  view.innerHTML = loading();
  try {
    const { projects } = await api("/api/projects");
    state.projects = projects;
    if (!projects.length) {
      view.innerHTML = empty("Sin proyectos", "Engram no tiene memorias todavía.");
      return;
    }
    view.innerHTML = `
      <div class="grid cols-3">
        ${projects.map((p) => `
          <div class="card project-card" data-project="${esc(p.name)}">
            <div class="name">${esc(p.name)}</div>
            <div class="counts">
              <span><b>${p.observations}</b> obs</span>
              <span><b>${p.sessions}</b> sesiones</span>
              <span><b>${p.prompts}</b> prompts</span>
            </div>
            ${p.directories && p.directories.length ? `<div class="dirs">
              ${p.directories.slice(0, 2).map((d) => `<div class="mono faint cell-cut" title="${esc(d)}">${esc(d)}</div>`).join("")}
              ${p.directories.length > 2 ? `<div class="faint">+${p.directories.length - 2} directorios más</div>` : ""}
            </div>` : ""}
            <div class="card-footer">
              <button class="btn danger sm" data-del-project="${esc(p.name)}"
                title="Cascada de borrado del proyecto">Eliminar proyecto</button>
            </div>
          </div>`).join("")}
      </div>`;
    view.querySelectorAll(".project-card").forEach((el) => {
      el.onclick = () => {
        state.project = el.dataset.project;
        localStorage.setItem("dash.project", state.project);
        state.session = "";
        state.obsIndex = null;
        syncProjectSelect();
        location.hash = "#/memories";
      };
    });
    view.querySelectorAll("button[data-del-project]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const p = projects.find((x) => x.name === btn.dataset.delProject);
        if (p) deleteProjectFlow(p);
      };
    });
  } catch (err) {
    view.innerHTML = banner(err);
  }
}

/* --- Prompts -------------------------------------------------------------------------- */

const PROMPTS_LIMIT = 200;

async function viewPrompts(view) {
  showProjectSelect(true);
  HL.term = "";
  view.innerHTML = loading();
  try {
    const data = await api(`/api/prompts?${scopeQS({ limit: PROMPTS_LIMIT }).toString()}`);
    const prompts = data.prompts || [];
    if (!prompts.length) {
      view.innerHTML = empty("Sin prompts", `No hay prompts guardados en ${scopeLabel()}.`);
      return;
    }
    const global = !state.project;
    view.innerHTML = `
      ${data.truncated
        ? `<div class="notice">Se listan los <b>${prompts.length}</b> prompts más recientes de ${esc(scopeLabel())} (límite de la petición).</div>`
        : `<div class="notice muted">Mostrando <b>${prompts.length}</b> prompts de ${esc(scopeLabel())}.</div>`}
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:80px">ID</th>
            ${global ? `<th style="width:130px">Proyecto</th>` : ""}
            <th style="width:180px">Sesión</th><th>Contenido</th>
            <th style="width:120px">Creado</th><th style="width:110px"></th></tr></thead>
          <tbody>
            ${prompts.map((p) => `
              <tr data-prompt-id="${esc(p.id)}">
                <td class="mono muted">#${esc(p.id)}</td>
                ${global ? `<td class="mono muted" title="${esc(p.project)}"><div class="cell-cut">${esc(p.project)}</div></td>` : ""}
                <td class="mono muted"><div class="cell-cut" title="${esc(p.session_id)}">${esc(p.session_id)}</div></td>
                <td><div class="preview">${highlight(esc(String(p.content || "").slice(0, 220)))}</div></td>
                <td class="muted" title="${esc(fmtDT(p.created_at))}">${rel(p.created_at)}</td>
                <td class="actions-cell"><button class="btn danger sm" data-del-prompt="${esc(p.id)}"
                  title="Borrar el prompt de forma permanente">Eliminar</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
    view.querySelectorAll("button[data-del-prompt]").forEach((btn) => {
      btn.onclick = () => {
        const p = prompts.find((x) => String(x.id) === btn.dataset.delPrompt);
        if (p) deletePromptFlow(p);
      };
    });
  } catch (err) {
    view.innerHTML = banner(err);
  }
}

/* --- borrado destructivo: snapshot primero + confirmación por nombre ------------------- */

/* Un único componente para toda acción irreversible (hard de observación, prompt,
   sesión vacía y cascada de proyecto). El modal simple (confirmModal) queda intacto
   para las acciones soft. Red de seguridad, en este orden:
   1. POST /api/snapshots antes de habilitar cualquier confirmación; sin snapshot
      vigente el backend rechaza el borrado y aquí el botón ni siquiera se activa.
   2. El botón de confirmación solo se habilita cuando el snapshot existe y el
      texto tipeado coincide exactamente con el id o el nombre del proyecto.
   3. El aviso de irreversibilidad es explícito y sin ambigüedad de deshacer.
   4. El error del backend se muestra tal cual (403 snapshot, 409 sesión con
      observaciones, 502 CLI). */

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/* Cierre del modal destructivo abierto, para que un cambio de vista no deje
   el backdrop tapando la vista siguiente. */
let closeDestructiveModal = null;

async function destructiveModal({
  title, introHtml, warnings = [], confirmLabel = "Eliminar definitivamente",
  confirmWord, modeChoice = null, request, successSummary, onSuccess,
}) {
  const backdrop = document.createElement("div");
  backdrop.className = "destructive-backdrop";
  backdrop.innerHTML = `
    <div class="destructive" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3>
      <p class="d-intro">${introHtml}</p>
      <ul class="d-warnings">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
      ${modeChoice ? `<div class="d-mode">${modeChoice.options.map((o, i) => `
        <label><input type="radio" name="d-mode" value="${esc(o.value)}" ${i === 0 ? "checked" : ""}>
          <span><b>${esc(o.label)}</b> ${esc(o.desc)}</span></label>`).join("")}
      </div>` : ""}
      <div class="d-snapshot pending" data-role="snapshot">Generando snapshot del export global…</div>
      <label class="d-typelabel">Esta operación no se puede deshacer. Para confirmar, escribe exactamente
        <b class="mono">${esc(confirmWord)}</b></label>
      <input type="text" class="d-confirm-input" data-role="confirm-input"
        autocomplete="off" spellcheck="false" disabled>
      <div data-role="feedback"></div>
      <div class="d-actions">
        <button class="btn ghost" data-role="cancel">Cancelar</button>
        <button class="btn danger" data-role="confirm" disabled>${esc(confirmLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const modal = $(".destructive", backdrop);
  const snapshotBox = $('[data-role="snapshot"]', modal);
  const input = $('[data-role="confirm-input"]', modal);
  const feedback = $("[data-role='feedback']", modal);
  const cancelBtn = $('[data-role="cancel"]', modal);
  const confirmBtn = $('[data-role="confirm"]', modal);

  let snapshotPath = null;
  let busy = false;
  let closed = false;
  /* El cierre por navegación se suspende solo durante onSuccess(): route() lo
     invocaría y destruiría el modal antes de mostrar el panel de resultado. */
  let autoCloseSuspended = false;
  const releaseFocus = trapFocus(modal);

  const close = () => {
    if (closed) return;
    closed = true;
    closeDestructiveModal = null;
    document.removeEventListener("keydown", onKey, true);
    releaseFocus();
    backdrop.remove();
  };
  /* route() cierra el modal abierto al navegar; durante onSuccess() la
     suspensión evita que la recarga de vista lanzada por el flujo de éxito lo
     cierre antes de pintar los contadores. Esc y el backdrop llaman a close()
     directamente y no pasan por aquí. */
  closeDestructiveModal = () => { if (!autoCloseSuspended) close(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  backdrop.onclick = (e) => { if (e.target === backdrop && !busy) close(); };
  cancelBtn.onclick = () => { if (!busy) close(); };

  const refreshConfirm = () => {
    confirmBtn.disabled = busy || !snapshotPath || input.value !== confirmWord;
  };
  input.addEventListener("input", refreshConfirm);

  const showFeedback = (html, kind = "") => {
    feedback.innerHTML = html ? `<div class="d-feedback ${kind}">${html}</div>` : "";
  };

  /* Snapshot primero: mientras no exista, ni el input ni el botón se habilitan. */
  try {
    const snap = await api("/api/snapshots", { method: "POST", body: {} });
    if (closed) return;
    snapshotPath = snap.path;
    snapshotBox.className = "d-snapshot";
    snapshotBox.innerHTML = `Snapshot listo (${esc(fmtBytes(snap.bytes))}):` +
      ` <span class="path">${esc(snap.path)}</span>`;
    input.disabled = false;
    input.focus();
  } catch (err) {
    if (closed) return;
    snapshotBox.className = "d-snapshot error";
    snapshotBox.textContent = `No se pudo generar el snapshot: ${err.error || "error inesperado"}. Sin snapshot vigente el backend rechaza el borrado.`;
  }
  refreshConfirm();

  confirmBtn.onclick = async () => {
    if (busy || !snapshotPath || input.value !== confirmWord) return;
    busy = true;
    refreshConfirm();
    cancelBtn.disabled = true;
    input.disabled = true;
    confirmBtn.textContent = "Eliminando…";
    showFeedback("");
    const mode = modeChoice ? $("input[name='d-mode']:checked", modal).value : null;
    try {
      const data = await request(snapshotPath, mode);
      autoCloseSuspended = true;
      try {
        if (onSuccess) onSuccess();
      } finally {
        /* Restaurado antes de renderizar el panel: no hay await entre medias,
           así que ningún evento puede cerrar el modal en ese hueco. */
        autoCloseSuspended = false;
      }
      if (closed) return;
      busy = false;
      modal.innerHTML = `
        <h3>${esc(title)}</h3>
        <div class="d-result">
          <p class="d-ok">Operación completada.</p>
          ${successSummary(data)}
        </div>
        <div class="d-actions">
          <button class="btn primary" data-role="close-done">Cerrar</button>
        </div>`;
      const done = $('[data-role="close-done"]', modal);
      done.onclick = close;
      done.focus();
    } catch (err) {
      if (closed) return;
      busy = false;
      confirmBtn.textContent = confirmLabel;
      cancelBtn.disabled = false;
      input.disabled = false;
      /* El mensaje del backend, verbatim: incluye el 409 de sesión con
         observaciones y el 403 de snapshot vencido. */
      showFeedback(esc(err.error || "Error inesperado"), "error");
      refreshConfirm();
    }
  };
}

/* Borrado físico de una observación desde el drawer. */
function hardDeleteObservation(obs) {
  destructiveModal({
    title: "Borrar definitivamente la memoria",
    introHtml: `Memoria <b class="mono">#${esc(obs.id)}</b> · ${esc(obs.title)}<br>Proyecto <b>${esc(obs.project)}</b>`,
    warnings: [
      "El borrado físico elimina la fila de la base de datos: no hay papelera ni forma de restaurar la memoria.",
      "El borrado soft (Ocultar) tampoco tiene deshacer, pero la fila permanece en el store.",
    ],
    confirmWord: String(obs.id),
    confirmLabel: "Eliminar definitivamente",
    request: (snapshotPath) => api(
      `/api/observations/${obs.id}?expected_project=${encodeURIComponent(obs.project)}&hard=true&snapshot=${encodeURIComponent(snapshotPath)}`,
      { method: "DELETE" }),
    successSummary: (d) => `<p class="d-counts">Observación <b class="mono">#${esc(d.id)}</b> eliminada físicamente${d.hard_delete === false ? " (el backend respondió soft)" : ""}.</p>`,
    onSuccess: () => {
      state.obsIndex = null;
      if (location.hash.startsWith("#/memories/obs/")) {
        history.replaceState(null, "", "#/memories");
      }
      closeDrawer();
      route();
    },
  });
}

/* Borrado permanente de un prompt (fila de la tabla Prompts). */
function deletePromptFlow(p) {
  destructiveModal({
    title: "Borrar prompt",
    introHtml: `Prompt <b class="mono">#${esc(p.id)}</b> · proyecto <b>${esc(p.project)}</b><br>Sesión <span class="mono">${esc(p.session_id)}</span>`,
    warnings: [
      "El prompt se borra de forma permanente: no hay papelera ni restore.",
    ],
    confirmWord: String(p.id),
    request: (snapshotPath) => api(
      `/api/prompts/${p.id}?snapshot=${encodeURIComponent(snapshotPath)}`,
      { method: "DELETE" }),
    successSummary: (d) => `<p class="d-counts">Prompt <b class="mono">#${esc(d.id)}</b>: eliminado de forma permanente.</p>`,
    onSuccess: () => route(),
  });
}

/* Borrado de una sesión sin observaciones (fila de la tabla Sessions). */
function deleteEmptySessionFlow(s) {
  destructiveModal({
    title: "Borrar sesión vacía",
    introHtml: `Sesión <b class="mono">${esc(s.id)}</b> · proyecto <b>${esc(s.project)}</b><br>La sesión no tiene observaciones.`,
    warnings: [
      "La sesión se borra de forma permanente: no hay papelera ni restore.",
      "El motor elimina también los prompts asociados a la sesión.",
    ],
    confirmWord: String(s.id),
    request: (snapshotPath) => api(
      `/api/sessions/${encodeURIComponent(s.id)}?snapshot=${encodeURIComponent(snapshotPath)}`,
      { method: "DELETE" }),
    successSummary: (d) => `<p class="d-counts">Sesión <b class="mono">${esc(d.id)}</b>: eliminada de forma permanente.</p>`,
    onSuccess: () => {
      if (location.hash.startsWith("#/sessions/")) {
        history.replaceState(null, "", "#/sessions");
      }
      route();
    },
  });
}

/* Cascada de proyecto: soft u hard, siempre con snapshot y nombre exacto. */
function deleteProjectFlow(p) {
  destructiveModal({
    title: "Eliminar proyecto",
    introHtml: `Proyecto <b class="mono">${esc(p.name)}</b><br>` +
      `Contenido actual: <b>${p.observations || 0}</b> observaciones, <b>${p.sessions || 0}</b> sesiones y <b>${p.prompts || 0}</b> prompts.`,
    warnings: [
      "La cascada es irreversible: no hay papelera ni restore.",
      `Incluso en modo soft los ${p.prompts || 0} prompts se borran para siempre y las ${p.sessions || 0} sesiones quedan vacías.`,
      "En modo hard se eliminan además las sesiones y las filas de la base de datos.",
    ],
    confirmWord: p.name,
    modeChoice: {
      options: [
        { value: "soft", label: "Soft",
          desc: `— oculta las ${p.observations || 0} observaciones; los prompts se pierden para siempre y las sesiones quedan vacías.` },
        { value: "hard", label: "Hard",
          desc: "— elimina también las sesiones y las filas físicamente." },
      ],
    },
    request: (snapshotPath, mode) => api(
      `/api/projects/${encodeURIComponent(p.name)}?snapshot=${encodeURIComponent(snapshotPath)}${mode === "hard" ? "&hard=true" : ""}`,
      { method: "DELETE" }),
    successSummary: (d) => `<p class="d-counts">Proyecto <b class="mono">${esc(d.project)}</b> (${d.hard ? "hard" : "soft"}): <b>${d.observations}</b> observaciones, <b>${d.prompts}</b> prompts y <b>${d.sessions}</b> sesiones afectadas.</p>`,
    onSuccess: () => {
      state.obsIndex = null;
      if (state.project === p.name) {
        state.project = ALL_PROJECTS;
        localStorage.setItem("dash.project", state.project);
        fillProjectSelect().then(syncProjectSelect);
      }
      route();
    },
  });
}

/* --- Salud: relaciones y revisión ----------------------------------------------------- */

const RELATION_LABELS = {
  pending: "pendiente", related: "relacionada", compatible: "compatible",
  scoped: "acotada", supersedes: "sustituye", conflicts_with: "en conflicto",
};

async function viewHealth(view) {
  showProjectSelect(true);
  HL.term = "";
  view.innerHTML = loading();
  const scope = scopeQS({ limit: 100, offset: state.cOffset });
  if (state.cStatus) scope.set("status", state.cStatus);
  try {
    const page = await api(`/api/conflicts?${scope}`);
    const [stats, review] = await Promise.all([
      api(`/api/conflicts/stats?${scopeQS()}`).catch(() => null),
      api(`/api/review?${scopeQS({ limit: 100 })}`).catch(() => null),
    ]);
    const relations = [...(page.relations || [])];
    const relationsShown = state.cRelation
      ? relations.filter((r) => r.relation === state.cRelation) : relations;
    const relationTypes = [...new Set(relations.map((r) => r.relation))].sort();

    view.innerHTML = `
      <div class="grid cols-3" style="margin-bottom:18px">
        <div class="card">
          <h3>Juicio de relaciones</h3>
          ${stats ? `
            <div class="mini-stats">
              <div class="mini"><span class="num mono">${(stats.by_judgment_status || {}).pending ?? 0}</span><span class="muted">pendientes</span></div>
              <div class="mini"><span class="num mono">${(stats.by_judgment_status || {}).judged ?? 0}</span><span class="muted">juzgadas</span></div>
              <div class="mini"><span class="num mono">${(stats.by_judgment_status || {}).orphaned ?? 0}</span><span class="muted">huérfanas</span></div>
            </div>` : `<div class="muted">Sin contadores disponibles.</div>`}
        </div>
        <div class="card">
          <h3>Tipos de relación</h3>
          ${stats && stats.by_relation ? `
            <div class="bars">
              ${Object.entries(stats.by_relation).sort((a, b) => b[1] - a[1]).map(([r, n]) => `
                <div class="bar-row">
                  <span class="badge t-unknown">${esc(RELATION_LABELS[r] || r)}</span>
                  <span class="mono muted">${n}</span>
                </div>`).join("")}
            </div>` : `<div class="muted">Sin relaciones registradas.</div>`}
        </div>
        <div class="card">
          <h3>Revisión</h3>
          ${review && review.count ? `
            <div class="mini-stats"><div class="mini">
              <span class="num mono">${review.count}</span><span class="muted">memorias con revisión vencida</span>
            </div></div>`
            : `<div class="muted">Ninguna memoria pide revisión en este ámbito.</div>`}
        </div>
      </div>

      ${review && review.count ? `
        <div class="card" style="margin-bottom:18px">
          <h3>Cola de revisión</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Memoria</th><th style="width:150px">Proyecto</th><th style="width:150px">Revisión</th></tr></thead>
            <tbody>
              ${(review.observations || []).map((o) => `
                <tr ${o.id ? `data-obs-id="${o.id}"` : ""}>
                  <td><div class="title">${esc(o.title)}</div>${o.topic_key ? `<div class="topic-key mono faint">${esc(o.topic_key)}</div>` : ""}</td>
                  <td class="mono muted">${esc(o.project || "—")}</td>
                  <td class="muted" title="${esc(fmtDT(o.review_after || o.updated_at))}">${rel(o.review_after || o.updated_at)}</td>
                </tr>`).join("")}
            </tbody>
          </table></div>
        </div>` : ""}

      <div class="card">
        <h3>Relaciones · ${page.total ?? relations.length}</h3>
        <div class="toolbar">
          <select id="conf-status">
            <option value="">Todos los estados</option>
            <option value="pending">Pendientes</option>
            <option value="judged">Juzgadas</option>
            <option value="orphaned">Huérfanas</option>
          </select>
          <select id="conf-relation">
            <option value="">Todos los tipos</option>
            ${relationTypes.map((r) => `<option value="${esc(r)}">${esc(RELATION_LABELS[r] || r)}</option>`).join("")}
          </select>
          <span class="muted">${state.cRelation ? `${relationsShown.length} de ${relations.length} cargadas` : ""}</span>
        </div>
        ${relationsShown.length ? `
          <div class="table-wrap"><table>
            <thead><tr><th style="width:120px">Relación</th><th style="width:110px">Juicio</th>
              <th>Origen</th><th>Destino</th><th style="width:110px">Creada</th></tr></thead>
            <tbody>
              ${relationsShown.map((r) => `
                <tr data-relation="${r.id}">
                  <td><span class="badge t-unknown">${esc(RELATION_LABELS[r.relation] || r.relation)}</span></td>
                  <td>${judgmentBadge(r.judgment_status)}</td>
                  <td><div class="title cell-cut" title="${esc(r.source_title)}">${esc(r.source_title)}</div></td>
                  <td><div class="title cell-cut" title="${esc(r.target_title)}">${esc(r.target_title)}</div></td>
                  <td class="muted" title="${esc(fmtDT(r.created_at))}">${rel(r.created_at)}</td>
                </tr>`).join("")}
            </tbody>
          </table></div>`
          : empty("Sin relaciones", `No hay relaciones ${state.cStatus ? `en estado ${state.cStatus} ` : ""}en ${scopeLabel()}.`)}
        ${relations.length < (page.total || 0) ? `
          <div style="text-align:center;margin-top:14px">
            <button class="btn" id="conf-more">Cargar más (${(page.total || 0) - relations.length} restantes)</button>
          </div>` : ""}
      </div>`;

    $("#conf-status").value = state.cStatus;
    $("#conf-status").onchange = (e) => {
      state.cStatus = e.target.value; state.cOffset = 0; viewHealth(view);
    };
    $("#conf-relation").value = state.cRelation;
    $("#conf-relation").onchange = (e) => { state.cRelation = e.target.value; viewHealth(view); };
    const more = $("#conf-more");
    if (more) more.onclick = () => { state.cOffset += (page.limit || 100); viewHealth(view); };
    view.querySelectorAll("tr[data-relation]").forEach((tr) => {
      tr.onclick = () => showRelation(tr.dataset.relation);
    });
    view.querySelectorAll("[data-obs-id]").forEach((el) => {
      el.onclick = () => openObservationFromList(el.dataset.obsId);
    });
  } catch (err) {
    if (err.status === 404) {
      view.innerHTML = surfaceGap(err, "Salud de memoria");
      return;
    }
    view.innerHTML = banner(err);
  }
}

/* Índice sync_id → id, construido bajo demanda desde el ámbito actual. */
async function obsIdBySync(syncId) {
  if (!state.obsIndex) {
    const data = await api(`/api/observations?${scopeQS({ limit: 50000 })}`);
    state.obsIndex = new Map(data.observations.map((o) => [o.sync_id, o.id]));
  }
  return state.obsIndex.get(syncId) || null;
}

async function showRelation(relationId) {
  try {
    const rel = await api(`/api/conflicts/${encodeURIComponent(relationId)}`);
    const block = (label, syncId, snippet) => `
      <div class="rel-side">
        <div class="faint">${esc(label)}</div>
        <div class="rel-snippet">${esc(snippet || "—")}</div>
        <button class="btn ghost" data-sync="${esc(syncId)}">Abrir observación</button>
      </div>`;
    openDrawer(`
      <div class="drawer-head">
        <div>
          <span class="badge t-unknown">${esc(RELATION_LABELS[rel.relation] || rel.relation)}</span>
          ${judgmentBadge(rel.judgment_status)}
          <h3 style="margin-top:8px">Relación #${esc(rel.relation_id)}</h3>
        </div>
        <button class="btn ghost icon" data-act="close" title="Cerrar">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10M17 7 7 17"/></g></svg>
        </button>
      </div>
      <div class="drawer-body">
        ${block("origen · " + rel.source_id, rel.source_id, rel.source_snippet)}
        ${block("destino · " + rel.target_id, rel.target_id, rel.target_snippet)}
        <dl class="meta-grid">
          <dt>relación</dt><dd>${esc(rel.relation)}</dd>
          <dt>juicio</dt><dd>${esc(rel.judgment_status)}</dd>
          <dt>creada</dt><dd>${fmtDT(rel.created_at)}</dd>
          <dt>actualizada</dt><dd>${fmtDT(rel.updated_at)}</dd>
        </dl>
        <div class="notice muted">El juicio de relaciones lo realizan los agentes por MCP; el dashboard solo lo muestra.</div>
      </div>`);
    $('[data-act="close"]', $("#drawer")).onclick = closeDrawer;
    $$("[data-sync]", $("#drawer")).forEach((btn) => {
      btn.onclick = async () => {
        const id = await obsIdBySync(btn.dataset.sync).catch(() => null);
        if (!id) {
          toast("La observación no está activa en el ámbito cargado", "error");
          return;
        }
        openObservationById(id);
      };
    });
  } catch (err) {
    toast(err.error || "No se pudo abrir la relación", "error");
  }
}

/* --- System --------------------------------------------------------------------------- */

async function viewSystem(view) {
  showProjectSelect(false);
  HL.term = "";
  view.innerHTML = loading();
  try {
    const [sys, doctor] = await Promise.all([
      api("/api/system"),
      api(`/api/doctor${state.project ? `?project=${encodeURIComponent(state.project)}` : ""}`),
    ]);
    setApiStatus(sys.status === "ok", sys.version, sys.compatible);
    state.compatible = sys.compatible !== false;
    view.innerHTML = `
      ${sys.version && !sys.compatible ? `
        <div class="banner warn" style="margin-bottom:16px">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="18" height="18" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 3 20h18Z"/><path d="M12 9v5"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></g></svg>
          <div>Versión del motor <b>${esc(sys.version)}</b> distinta de la verificada (<b>${esc(sys.verified_version)}</b>): el dashboard funciona, pero el contrato no está comprobado contra ella.</div>
        </div>` : ""}
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card">
          <h3>Motor</h3>
          <dl class="kv">
            <dt>versión</dt><dd>${esc(sys.version || "—")}</dd>
            <dt>estado API</dt><dd>${esc(sys.status)}</dd>
            <dt>verificado</dt><dd>${esc(sys.verified_version)}</dd>
            <dt>API</dt><dd>${esc(sys.api_base)}</dd>
            <dt>binario</dt><dd>${esc(sys.engram_bin)}</dd>
          </dl>
        </div>
        <div class="card">
          <h3>Datos</h3>
          <dl class="kv">
            <dt>directorio</dt><dd>${esc(sys.data_dir)}</dd>
            <dt>base SQLite</dt><dd>${esc(sys.db_path)}</dd>
            <dt>dashboard</dt><dd>http://${esc(sys.host)}:${sys.port}</dd>
            <dt>host</dt><dd>${esc(sys.host)}</dd>
          </dl>
          <div class="drawer-actions">
            ${state.project
              ? `<button class="btn" id="export-project">Exportar JSON de ${esc(state.project)}</button>`
              : `<span class="muted">Selecciona un proyecto en Memories o Sessions para exportar su JSON.</span>`}
          </div>
        </div>
      </div>
      <div class="card">
        <h3>Doctor · ${esc(doctor.project || "")} — ${doctor.summary.ok}/${doctor.summary.total} OK
          ${doctor.summary.warnings ? `· ${doctor.summary.warnings} avisos` : ""}</h3>
        ${doctor.checks.map((c) => `
          <div class="check ${esc(c.result)}">
            <span class="ico"></span>
            <div>
              <div class="msg mono" style="font-size:12px">${esc(c.check_id)}</div>
              <div>${esc(c.message)}</div>
              ${c.why ? `<div class="why">${esc(c.why)}</div>` : ""}
            </div>
          </div>`).join("")}
      </div>`;
    const exp = $("#export-project");
    if (exp) exp.onclick = () => downloadProjectExport(state.project);
  } catch (err) {
    view.innerHTML = banner(err);
  }
}

/* --- topbar / proyectos ------------------------------------------------------------------ */

function showProjectSelect(show) {
  const sel = $("#project-select");
  sel.hidden = !show;
  if (show) fillProjectSelect();
}

async function fillProjectSelect() {
  const sel = $("#project-select");
  try {
    const { projects } = await api("/api/projects");
    state.projects = projects;
    const names = projects.map((p) => p.name);
    if (state.project && !names.includes(state.project)) {
      state.project = ALL_PROJECTS;
      localStorage.setItem("dash.project", state.project);
    }
    sel.innerHTML = `<option value="">Todos los proyectos</option>` +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.value = state.project;
  } catch {
    sel.innerHTML = `<option value="">—</option>`;
  }
}

function syncProjectSelect() {
  const sel = $("#project-select");
  if (sel.options.length) sel.value = state.project;
}

$("#project-select").addEventListener("change", (e) => {
  state.project = e.target.value;
  state.session = "";
  state.offset = 0;
  state.cOffset = 0;
  state.obsIndex = null;
  localStorage.setItem("dash.project", state.project);
  route();
});

$("#refresh-btn").addEventListener("click", () => {
  state.obsIndex = null;
  loadStatus();
  route();
});

/* --- estado API en sidebar ------------------------------------------------------------------ */

function setApiStatus(ok, version, compatible = true) {
  $("#api-dot").className = `dot ${ok ? "ok" : "down"}`;
  $("#api-label").textContent = ok
    ? (compatible ? "API conectada" : "API ok · no verificada")
    : "API no disponible";
  $("#api-version").textContent = version ? `engram ${version}` : "";
}

/* Pulso de cabecera y cinta de pie: solo señales reales del backend. */
function setPulses(html) {
  $("#pulses").innerHTML = html.filter(Boolean).join("");
}

function setTicker(pairs) {
  $("#ticker").innerHTML = pairs
    .map(([k, v]) => `<span>${esc(k)} <b>${esc(String(v))}</b></span>`).join("") +
    `<span class="sep"></span><span>engram · <b>local</b></span>`;
}

async function loadStatus() {
  try {
    const sys = await api("/api/system");
    state.system = sys;
    state.compatible = sys.compatible !== false;
    setApiStatus(sys.status === "ok", sys.version, state.compatible);
    if (location.hash.replace(/^#\/?/, "").split("/")[0] !== "overview") {
      setPulses([
        `<span class="pill ${sys.status === "ok" ? "ok" : "warn"}">
          <i class="dot ${sys.status === "ok" ? "ok" : "down"}"></i>API ${esc(sys.version || "sin versión")}</span>`,
        sys.compatible ? "" : `<span class="pill warn">motor sin verificar</span>`,
      ]);
      setTicker([["proyecto", state.project || "todos"], ["verificado", sys.verified_version]]);
    }
  } catch {
    setApiStatus(false);
    setPulses(`<span class="pill warn"><i class="dot down"></i>API no disponible</span>`);
  }
}

/* --- sondeo de salud -------------------------------------------------------------------------- */

/* GET /api/health reenvía /health del motor: { ok, engram: { status, version } }.
   El sondeo mantiene la píldora lateral al día sin depender del refresco manual.
   Con la pestaña oculta no se lanza petición y una en curso nunca se solapa con
   la siguiente; un fallo degrada la píldora a estado offline sin propagar nada. */
const HEALTH_POLL_MS = 15000;
let healthPollTimer = null;
let healthPollBusy = false;

async function pollHealth() {
  if (document.hidden || healthPollBusy) return;
  healthPollBusy = true;
  try {
    const data = await api("/api/health");
    const engine = (data && data.engram) || {};
    setApiStatus(data.ok === true && engine.status === "ok", engine.version, state.compatible);
  } catch {
    setApiStatus(false);
  } finally {
    healthPollBusy = false;
  }
}

function startHealthPolling() {
  if (healthPollTimer) return;
  healthPollTimer = setInterval(pollHealth, HEALTH_POLL_MS);
}

/* --- teclado ---------------------------------------------------------------------------------- */

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === "k") {
    e.preventDefault();
    focusSearch();
    return;
  }
  if (e.key === "Escape") {
    closeDrawer();
    $("#modal-backdrop").hidden = true;
  }
});

async function focusSearch() {
  if (!$("#q")) {
    state.focusSearch = true;
    location.hash = "#/memories";
    return;
  }
  const q = $("#q");
  q.focus();
  q.select();
}

/* --- router ----------------------------------------------------------------------------------- */

const TITLES = { overview: "Overview", memories: "Memories", sessions: "Sessions",
  prompts: "Prompts", projects: "Projects", health: "Salud de memoria", system: "System" };

/* Eyebrow de cabecera: micro-etiqueta fija por vista, como el rótulo del panel. */
const EYEBROWS = { overview: "engram · panel global", memories: "engram · memorias",
  sessions: "engram · sesiones", prompts: "engram · prompts",
  projects: "engram · proyectos",
  health: "engram · salud de memoria", system: "engram · sistema",
  "session-detail": "engram · sesión" };

function listHashFor(name) {
  return `#/${name === "memories" ? "memories" : name}`;
}

async function route() {
  if (closeDestructiveModal) closeDestructiveModal();
  const parts = (location.hash.replace(/^#\/?/, "") || "overview").split("/");
  const name = parts[0] || "overview";
  const isObs = name === "memories" && parts[1] === "obs" && parts[2];
  const isSession = name === "sessions" && parts[1];
  const view = isSession ? "session-detail" : (TITLES[name] ? name : "overview");
  if (!isObs && !$("#drawer").hidden) closeDrawer();

  document.querySelectorAll("#nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === (view === "session-detail" ? "sessions" : view));
  });
  $("#view-title").textContent = view === "session-detail" ? "Session" : TITLES[view];
  $("#view-eyebrow").textContent = EYEBROWS[view] || "engram · local";
  const el = $("#view");
  el.innerHTML = loading();
  if (view === "overview") return viewOverview(el);
  if (view === "memories") {
    await viewMemories(el);
    if (isObs) openObservationById(decodeURIComponent(parts[2]));
    return;
  }
  if (view === "sessions") return viewSessions(el);
  if (view === "session-detail") return viewSessionDetail(el, decodeURIComponent(parts[1]));
  if (view === "prompts") return viewPrompts(el);
  if (view === "projects") return viewProjects(el);
  if (view === "health") return viewHealth(el);
  if (view === "system") return viewSystem(el);
}

window.addEventListener("hashchange", route);

/* --- arranque ----------------------------------------------------------------------------------- */

(async function boot() {
  await loadStatus();
  await route();
  fillProjectSelect().then(syncProjectSelect);
  startHealthPolling();
})();
