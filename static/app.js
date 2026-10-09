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
        <button class="btn danger" data-act="delete">Eliminar</button>
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
  $('[data-act="delete"]', $("#drawer")).onclick = () => confirmModal({
    title: "¿Eliminar esta memoria?",
    bodyHtml: `<b>${esc(obs.title)}</b><br><br>Se realiza un borrado <b>soft</b>: la observación queda oculta en el listado (el borrado definitivo solo existe vía CLI, <span class="mono">engram delete ${obs.id} --hard</span>).`,
    confirmText: "Eliminar",
    onConfirm: async () => {
      await api(`/api/observations/${obs.id}?expected_project=${encodeURIComponent(obs.project)}`, { method: "DELETE" });
      toast("Memoria eliminada (soft)", "ok");
      state.obsIndex = null;
      closeDrawer();
      route();
    },
  });
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
        </div>
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

/* --- panel de control: color por tipo, radial, sparkline, carriles ------------- */

/* Un mismo color por tipo en el radial, las barras y las etiquetas. */
const TYPE_HUE = {
  decision: "#7ef0a0", architecture: "#a78bfa", bugfix: "#ff7a7a", config: "#ffd166",
  discovery: "#3ff0c0", learning: "#9ee37d", pattern: "#5eead4", preference: "#7fdcff",
  session_summary: "#fbbf24", bug: "#f59e0b", error: "#ff6b6b", manual: "#94a3b8",
};
const typeColor = (t) => TYPE_HUE[t] || "#8aa0a0";

const pct = (n, d) => (d ? (n * 100) / d : 0);
const fmtPct = (n, d) => (d ? `${pct(n, d).toFixed(1).replace(/\.0$/, "")}%` : "—");

/* Anillos concéntricos: un anillo por tipo, arco proporcional a su cuota y hueco
   a las 12 en punto para que la etiqueta del anillo quepa sin taparlo.
   El número de anillos está acotado por la legibilidad de la etiqueta: los tipos
   restantes se agrupan en un único anillo "otros", sin perder el desglose, que
   sigue íntegro en la leyenda y en las barras. */
const RADIAL_MAX = 9;

function renderRadial(byType, total) {
  const all = Object.entries(byType || {}).sort((a, b) => b[1] - a[1]);
  const head = all.slice(0, RADIAL_MAX - (all.length > RADIAL_MAX ? 1 : 0));
  const tail = all.slice(head.length);
  const ringsData = tail.length
    ? [...head, ["otros", tail.reduce((acc, [, n]) => acc + n, 0)]]
    : all;

  const S = 420, cx = 210, cy = 210, rOut = 200, rIn = 62, GAP_DEG = 16;
  const n = ringsData.length;
  const step = n ? (rOut - rIn) / n : 0;
  const width = Math.max(4, Math.min(13, step * 0.62));

  /* Sin texto dentro del radial: un hueco angular no puede alojar etiquetas
     largas en anillos de radios distintos. Cada anillo se identifica por su
     color, y la leyenda de debajo (mismo panel) da tipo y recuento. */
  const rings = ringsData.map(([type, count], i) => {
    const r = rOut - step * (i + 0.5);
    const C = 2 * Math.PI * r;
    const gap = (C * GAP_DEG) / 360;
    const arc = (C - gap) * (total ? count / total : 0);
    const color = type === "otros" ? "#a78bfa" : typeColor(type);
    return `
      <circle class="mc-ring-track" cx="${cx}" cy="${cy}" r="${r}" stroke-width="${width}"/>
      <circle class="mc-ring-arc" data-ring="${esc(type)}" cx="${cx}" cy="${cy}" r="${r}" stroke="${color}"
        style="--w:${width}" stroke-width="${width}" stroke-dasharray="${arc} ${C - arc}"
        transform="rotate(${-90 + GAP_DEG / 2} ${cx} ${cy})"><title>${esc(type)}: ${count} (${fmtPct(count, total)})</title></circle>`;
  });

  if (!n) {
    rings.push(`
      <circle class="mc-ring-track" cx="${cx}" cy="${cy}" r="${(rOut + rIn) / 2}" stroke-width="10"
        stroke-dasharray="3 9" stroke-linecap="round"/>`);
  }

  const breakdown = all.map(([t, c]) => `${t} ${c}`).join(", ") || "sin tipos";
  return `<svg viewBox="0 0 ${S} ${S}" role="img"
      aria-label="Distribución por tipo: ${total} observaciones en ${all.length} tipos. ${breakdown}.">
    <defs>
      <linearGradient id="mc-sweep-grad" x1="210" y1="10" x2="304.1" y2="33.4" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3ff0c0" stop-opacity="0"/>
        <stop offset=".72" stop-color="#3ff0c0" stop-opacity=".10"/>
        <stop offset="1" stop-color="#7ef0d8" stop-opacity=".34"/>
      </linearGradient>
      <radialGradient id="mc-core-glow">
        <stop offset="0" stop-color="#3ff0c0" stop-opacity=".16"/>
        <stop offset="1" stop-color="#3ff0c0" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="96" fill="url(#mc-core-glow)"/>
    ${rings.join("")}
    <g class="mc-sweep">
      <path d="M210 210 L210 10 A200 200 0 0 1 304.1 33.4 Z" fill="url(#mc-sweep-grad)"/>
      <line class="mc-sweep-edge" x1="210" y1="210" x2="304.1" y2="33.4"/>
    </g>
  </svg>`;
}

/* Serie diaria real (activity.by_day). Sin dato no se dibuja línea. */
function renderSpark(byDay) {
  const days = Object.entries(byDay || {});
  if (days.length < 2) return "";
  const W = 200, H = 32, max = Math.max(...days.map(([, v]) => v), 1);
  const dx = W / (days.length - 1);
  const d = days.map(([, v], i) => {
    const x = (i * dx).toFixed(2);
    const y = (H - 2 - (v / max) * (H - 6)).toFixed(2);
    return `${i ? "L" : "M"}${x} ${y}`;
  }).join(" ");
  const active = days.filter(([, v]) => v > 0).length;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Actividad diaria: ${active} de ${days.length} días con memoria nueva, máximo ${max}.">
    <path class="spark-line" vector-effect="non-scaling-stroke" d="${d}"/>
  </svg>`;
}

/* Tile KPI: etiqueta micro, cifra dominante, unidad y caption propio. */
const tile = ({ label, num, unit = "", caption, tone = "", bar = null, strip = "" }) => `
  <div class="tile ${tone}">
    <span class="eyebrow">${esc(label)}</span>
    <span class="num">${num}${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</span>
    <span class="caption">${caption}</span>
    ${bar === null ? strip : `<div class="bar-track"><div class="bar-fill" style="width:${bar}%;background:${tone === "violet" ? "var(--violet)" : "var(--accent)"}"></div></div>`}
  </div>`;

function laneFreshness(ts) {
  const d = parseTs(ts);
  if (!d) return "idle";
  const hours = (Date.now() - d.getTime()) / 36e5;
  return hours < 24 ? "fresh" : hours < 24 * 7 ? "warm" : hours < 24 * 30 ? "cold" : "idle";
}

function renderLanes(projects, total) {
  if (!projects.length) {
    return `<section class="lanes"><div class="lanes-head"><span class="name">carriles · sin proyectos</span></div>
      ${empty("Sin proyectos", "Engram todavía no tiene memoria por proyecto.")}</section>`;
  }
  const max = Math.max(...projects.map((p) => p.observations || 0), 1);
  const sum = projects.reduce((acc, p) => acc + (p.observations || 0), 0);
  return `
    <section class="lanes">
      <div class="lanes-head">
        <span class="name"><b>${projects.length}</b> carriles</span>
        <span class="vsep">·</span>
        <span class="name"><b>${sum}</b> obs en el ámbito</span>
        <span class="vsep">·</span>
        <span class="name">ordenados por peso</span>
        <span class="lanes-pills">${["fresh", "warm", "cold", "idle"].map((tone) => {
          const n = projects.filter((p) => laneFreshness(p.last_activity) === tone).length;
          return n ? `<span class="lane-pill"><i class="dot ${tone === "idle" ? "" : "ok"}" style="background:${
            { fresh: "var(--accent)", warm: "var(--accent-2)", cold: "var(--warn)" }[tone] || "var(--faint)"}"></i>${n}</span>` : "";
        }).join("")}</span>
      </div>
      <div class="lanes-grid">
        ${projects.map((p) => `
          <button class="lane" type="button" data-project="${esc(p.name)}"
            title="Abrir las memorias de ${esc(p.name)}">
            <span class="status ${laneFreshness(p.last_activity)}"></span>
            <span class="lname">${esc(p.name)}</span>
            <span class="lcount">${p.observations || 0}<small>obs</small></span>
            <span class="lmeta"><b>${p.sessions || 0}</b> sesiones · <b>${p.prompts || 0}</b> prompts · ${fmtPct(p.observations || 0, total)} del ámbito · ${p.last_activity ? esc(rel(p.last_activity)) : "sin fecha"}</span>
            <span class="lbar"><i style="width:${Math.max(2, Math.round((p.observations || 0) * 100 / max))}%"></i></span>
          </button>`).join("")}
      </div>
    </section>`;
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
    const byType = Object.entries(a.by_type || {}).sort((x, y) => y[1] - x[1]);
    const projects = [...data.projects]
      .sort((x, y) => (y.observations || 0) - (x.observations || 0));

    setPulses([
      `<span class="pill ${data.health.status === "ok" ? "ok" : "warn"}">
        <i class="dot ${data.health.status === "ok" ? "ok" : "down"}"></i>API ${esc(data.health.version || "?")}</span>`,
      `<span class="pill"><b>${a.d1}</b>&nbsp;mem 24 h</span>`,
      data.truncated ? `<span class="pill warn">ventana ${loaded}/${t.observations}</span>` : "",
      state.compatible ? "" : `<span class="pill warn">motor sin verificar</span>`,
      `<span class="pill">carga ${esc((data.loaded_at || "").slice(11, 19))}</span>`,
    ]);

    setTicker([
      ["observaciones", t.observations], ["sesiones", t.sessions],
      ["proyectos", t.projects], ["tipos", byType.length],
      ["cargadas", loaded], ["cargado", rel(data.loaded_at)],
    ]);

    view.innerHTML = `
      <div class="mc">
        <div class="mc-panel">
          <span class="eyebrow">distribución por tipo · ${byType.length} tipo${byType.length === 1 ? "" : "s"} · ${loaded} cargadas</span>
          <div class="mc-rings">
            ${renderRadial(a.by_type, loaded)}
            <div class="mc-center">
              <span class="num">${loaded}</span>
              <span class="unit">observaciones</span>
              <span class="sub">${t.observations} activas en total${data.truncated ? " · ventana acotada" : ""}</span>
            </div>
          </div>
          <div class="mc-legend">
            ${byType.map(([type, n]) => `<button class="lg" type="button" data-lg="${esc(type)}"
              title="Ver las memorias de tipo ${esc(type)}">
              <i style="background:${typeColor(type)}"></i>${esc(type)} <b>${n}</b>
              <em>${fmtPct(n, loaded)}</em></button>`).join("")
              || `<span class="muted">Sin observaciones activas en el ámbito.</span>`}
          </div>
        </div>

        <div class="mc-panel">
          <span class="eyebrow">ritmo · últimos 7 días</span>
          <div class="mc-hero">
            <span class="num">${fmtPct(a.d7, t.observations).replace("%", "")}<span class="unit">%</span></span>
            <span class="caption"><b>${a.d7}</b> de <b>${t.observations}</b> memorias se crearon en los últimos 7 días</span>
          </div>
          <div class="bars">
            ${byType.map(([type, n]) => `
              <div class="bar-row" data-bar="${esc(type)}">
                ${badge(type)}
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Math.round(n * 100 / (loaded || 1)))}%;background:${typeColor(type)}"></div></div>
                <span class="mono">${n} · ${fmtPct(n, loaded)}</span>
              </div>`).join("") || `<div class="caption muted">Sin observaciones activas en el ámbito.</div>`}
          </div>
          <div class="mc-split">
            <span class="eyebrow">actividad diaria · 30 d</span>
            ${renderSpark(a.by_day)}
            <span class="val">${a.d30} en 30 d</span>
          </div>
          <div class="mc-split">
            <span class="eyebrow">ventana cargada</span>
            <div class="bar-track">
              <div class="bar-fill" style="width:${Math.min(100, Math.round(loaded * 100 / (t.observations || 1)))}%;background:var(--violet)"></div>
            </div>
            <span class="val">${loaded} / ${t.observations}</span>
          </div>
        </div>
      </div>

      <div class="mc-tiles">
        ${tile({ label: "memorias", num: t.observations, tone: "accent",
          caption: "observaciones activas en el motor",
          strip: `<span class="strip">${byType.map(([type, n]) => `<i style="background:${typeColor(type)};flex-grow:${Math.max(n, .35)}"></i>`).join("") || `<i></i>`}</span>` })}
        ${tile({ label: "sesiones", num: t.sessions, caption: "sesiones que escribieron memoria" })}
        ${tile({ label: "proyectos", num: t.projects, caption: "proyectos con memoria" })}
        ${tile({ label: "hoy · 24 h", num: a.d1, caption: "memorias creadas en las últimas 24 h",
          bar: Math.min(100, Math.round(pct(a.d1, t.observations || 1))) })}
        ${tile({ label: "semana · 7 d", num: a.d7, tone: "violet", caption: "memorias creadas en los últimos 7 días",
          bar: Math.min(100, Math.round(pct(a.d7, t.observations || 1))) })}
        ${tile({ label: "mes · 30 d", num: a.d30, tone: "violet", caption: "memorias creadas en los últimos 30 días",
          bar: Math.min(100, Math.round(pct(a.d30, t.observations || 1))) })}
      </div>

      ${renderLanes(projects, t.observations)}

      <div class="card" style="margin-top:10px">
        <h3>Actividad reciente</h3>
        ${data.recent.length ? `<div class="timeline">${data.recent.map(obsCard).join("")}</div>`
          : empty("Sin actividad", "Aún no hay memorias registradas.")}
      </div>`;

    wireObsCards(view);
    wireRadial(view);
    view.querySelectorAll(".lane").forEach((el) => {
      el.onclick = () => {
        state.project = el.dataset.project;
        localStorage.setItem("dash.project", state.project);
        state.session = "";
        state.obsIndex = null;
        syncProjectSelect();
        location.hash = "#/memories";
      };
    });
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

/* Cada anillo, su barra y su entrada de leyenda comparten `data-*` con el tipo:
   pasar el ratón por cualquiera de los tres resalta los otros dos. La leyenda
   es la vía accesible (botón real) para abrir las memorias de ese tipo. */
function wireRadial(root) {
  const on = (type) => {
    root.querySelectorAll("[data-ring], [data-bar], [data-lg]").forEach((el) => {
      const key = el.dataset.ring || el.dataset.bar || el.dataset.lg;
      el.classList.toggle("hot", key === type);
    });
  };
  root.querySelectorAll("[data-ring], [data-bar], [data-lg]").forEach((el) => {
    const type = el.dataset.ring || el.dataset.bar || el.dataset.lg;
    el.onmouseenter = () => on(type);
    el.onmouseleave = () => on(null);
  });
  root.querySelectorAll(".lg").forEach((btn) => {
    btn.onclick = () => {
      state.type = btn.dataset.lg;
      state.q = "";
      HL.term = "";
      location.hash = "#/memories";
    };
  });
  root.querySelectorAll(".mc-ring-arc").forEach((arc) => {
    arc.onclick = () => {
      const t = arc.dataset.ring;
      if (t === "otros") { toast("Abre Memories y filtra por tipo para ver el detalle", ""); return; }
      state.type = t;
      state.q = "";
      HL.term = "";
      location.hash = "#/memories";
    };
  });
}

/* El radar no gira con la pestaña oculta ni con movimiento reducido. */
document.addEventListener("visibilitychange", () => {
  document.body.dataset.hidden = document.hidden ? "1" : "";
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
            <th style="width:140px">Memorias</th><th style="width:180px">Inicio</th></tr></thead>
          <tbody>
            ${sessions.map((s) => `
              <tr data-session="${esc(s.id)}">
                <td class="mono"><div class="cell-cut" title="${esc(s.id)}">${esc(s.id)}</div></td>
                ${global ? `<td class="mono muted">${esc(s.project)}</td>` : ""}
                <td><b class="mono">${s.observation_count}</b> <span class="faint">obs</span></td>
                <td class="muted" title="${esc(fmtDT(s.started_at))}">${rel(s.started_at)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
    view.querySelectorAll("tr[data-session]").forEach((tr) => {
      tr.onclick = () => { location.hash = `#/sessions/${encodeURIComponent(tr.dataset.session)}`; };
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
  } catch (err) {
    view.innerHTML = banner(err);
  }
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
  projects: "Projects", health: "Salud de memoria", system: "System" };

/* Eyebrow de cabecera: micro-etiqueta fija por vista, como el rótulo del panel. */
const EYEBROWS = { overview: "engram · panel global", memories: "engram · memorias",
  sessions: "engram · sesiones", projects: "engram · proyectos",
  health: "engram · salud de memoria", system: "engram · sistema",
  "session-detail": "engram · sesión" };

function listHashFor(name) {
  return `#/${name === "memories" ? "memories" : name}`;
}

async function route() {
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
})();
