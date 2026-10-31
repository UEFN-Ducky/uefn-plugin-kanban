/* Kanban panel: every button calls the same RPC as a kanban_* tool. */
"use strict";

const CHANNEL = "uefn-plugin-ui";
const COLORS = ["blue", "green", "red", "purple", "amber", "yellow"];
const PRIOS = [["urgent", "Urgent"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]];
const GLYPHS = ["★", "◆", "●", "▲", "■", "♥", "⚑", "✎", "✦", "❖", "✿", "♪", "⌘", "☾", "☀", "✱", "◎", "⬢", "✚", "➜", "§"];
const POLL_MS = 4000;

function call(method, params = {}) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  return new Promise((resolve, reject) => {
    function onMsg(ev) {
      const d = ev.data;
      if (!d || d.channel !== CHANNEL || d.id !== id || d.method) return;  // a reply, never a request
      window.removeEventListener("message", onMsg);
      d.ok ? resolve(d.result) : reject(new Error(d.error || "bridge error"));
    }
    window.addEventListener("message", onMsg);
    parent.postMessage({ channel: CHANNEL, id, method, params }, "*");
  });
}
const rpc = (method, params = {}) => call("plugin.call", { method, params }).catch((err) => ({ ok: false, error: err.message }));
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
const svg = (d, size = 16, w = 1.5) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  plus: '<path d="M8 3v10M3 8h10"/>', dots: '<circle cx="4" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12" cy="8" r=".9" fill="currentColor"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>', lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  warn: '<path d="M8 2.5L14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>', clip: '<path d="M8.5 5.5L5.2 8.8a1.6 1.6 0 0 1-2.3-2.3l4-4a1.1 1.1 0 0 1 1.6 1.6L4.6 8"/>',
  chat: '<path d="M2 2.5h8v5.5H5.5L3 10V8H2z"/>', trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  link: '<path d="M6 8a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.7.7M8 6a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 6 11.5l.7-.7"/>',
  upload: '<path d="M8 11V3M5 6l3-3 3 3M2.5 11.5V13h11v-1.5"/>', chev: '<path d="M4 6l4 4 4-4"/>', check: '<path d="M4 8.5l2.5 2.5 5.5-6"/>',
  cal: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  image: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><circle cx="6" cy="6.5" r="1"/><path d="M3 12l3.5-3.5 2.5 2.5 1.5-1.5L13 12"/>',
};

const S = {
  boards: [], templates: [], boardId: "", v: null, scope: null, prefs: {}, people: [],
  filter: { people: [], labels: [], prios: [] }, q: "", menu: "", modal: "", page: "general",
  open: "", openMine: false, expired: false, drag: "", over: null, adding: "", seen: {}, visible: true,
  tpl: "sprint", thumbs: {}, linkOpen: false, lightbox: null, calMonth: "", known: null,
};
// What the last frame showed: animations play once, when something opens, never on a re-render.
const F = { modalKey: "", menu: "" };

// ---------------------------------------------------------------- helpers

function whoKey(by) {
  by = by || {};
  return `${by.kind}|${by.user || by.for || by.name}|${by.kind === "ducky" ? by.name : ""}`;
}
function whoLabel(by) {
  by = by || {};
  if (by.kind === "ducky") return by.name && by.for ? `${by.name} (${by.for}'s ducky)` : by.name ? `${by.name} (ducky)` : `${by.for || "A"}'s ducky`;
  return by.name || "Someone";
}
function colorOf(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : (parts[0] || "")[1] || "")).toUpperCase();
}
function avatar(by, cls = "") {
  if (!by) return `<span class="kb-av none ${cls}"></span>`;
  return `<span class="kb-av ${by.kind === "ducky" ? "ducky" : ""} c-${colorOf(by.name)} ${cls}" title="${esc(whoLabel(by))}">${esc(initials(by.name))}</span>`;
}
function ago(t) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - (t || 0)));
  if (s < 5) return "now"; if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
const pad2 = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => iso(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const fmtDate = (d, long) => new Date(`${d}T00:00`).toLocaleDateString(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
const board = () => (S.v && S.v.board) || null;
const cards = () => (S.v && S.v.cards) || [];
const cardById = (id) => cards().find((c) => c.id === id);
const colTitle = (id) => (board()?.columns.find((c) => c.id === id) || {}).title || "";
const settings = () => (board() && board().settings) || {};
const lastCol = () => { const c = board()?.columns || []; return c.length ? c[c.length - 1].id : ""; };
function lockFor(card) {
  const locks = (S.v && S.v.locks) || [];
  return locks.find((l) => l.column && l.colId === card.colId) || locks.find((l) => !l.column && l.card === slug(card.id)) || null;
}
function pct(lk) {
  if (!lk || !lk.lease) return "";
  const left = Math.max(0, lk.touched + lk.lease - Date.now() / 1000);
  return `${Math.round(100 - (left / lk.lease) * 100)}%`;
}
/** Set innerHTML only when it changed: no flicker, no lost hover, no replayed animations. */
function setHTML(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}
let toastT = 0;
function toast(text) {
  clearTimeout(toastT);
  $("toast").innerHTML = text ? `<div class="kb-toast" role="status"><span class="kb-dot"></span>${esc(text)}</div>` : "";
  if (text) toastT = setTimeout(() => toast(""), 3600);
}
async function act(promise, okText) {
  const r = await promise;
  if (r && r.ok === false) { toast(r.error || "That didn't work."); await loadView(); return null; }
  if (okText) toast(okText);
  await loadView();
  return r;
}
async function confirmBox(message, title, confirm = "Delete") {
  try { return !!(await call("ui.confirm", { message, title, confirm, danger: true })).confirmed; } catch { return false; }
}

// ---------------------------------------------------------------- loading

async function loadBoards() {
  const r = await rpc("boards");
  if (!r.ok) { setHTML($("main"), `<div class="dk-error" style="margin:auto"><div class="dk-error__title">Couldn't load boards</div>${esc(r.error)}</div>`); return; }
  S.boards = r.boards; S.templates = r.templates;
  if (!S.boards.find((b) => b.id === S.boardId)) S.boardId = (S.boards[0] || {}).id || "";
  if (S.boardId) await loadView(); else { S.v = null; render(); }
}
async function loadView() {
  if (!S.boardId) return render();
  const r = await rpc("view", { board: S.boardId });
  if (!r.ok) { S.boardId = ""; return loadBoards(); }
  const wasMine = S.open && S.openMine;
  S.v = r;
  if (wasMine) {
    const c = cardById(S.open), lk = c && lockFor(c);
    if (!c) { S.open = ""; S.modal = ""; toast("That card was deleted."); }
    else if (!lk || !lk.mine) { S.openMine = false; S.expired = !lk; if (lk) toast(`${lk.who} took it.`); }
  } else if (S.open && S.modal === "card") {
    const c = cardById(S.open), lk = c && lockFor(c);
    if (c && !lk && !S.expired) {
      const got = await rpc("lock", { board: S.boardId, card: S.open });
      if (got.ok) { S.openMine = true; toast("It's free now. You can edit."); const again = await rpc("view", { board: S.boardId }); if (again.ok) S.v = again; }
    }
  }
  render();
}
async function loadPeople() {
  const r = await rpc("people", { board: S.boardId });
  S.people = r.ok ? r.people : [];
}
async function selectBoard(id) {
  if (S.open) await closeCard();
  S.boardId = id; S.modal = ""; S.known = null; S.filter = { people: [], labels: [], prios: [] };
  call("prefs.set", { id: "board", value: id }).catch(() => {});
  await loadView();
  loadPeople();
}

// ---------------------------------------------------------------- board

function matches(c) {
  const f = S.filter, q = S.q.trim().toLowerCase();
  if (q && !`${c.id} ${c.title} ${c.desc}`.toLowerCase().includes(q)) return false;
  if (f.people.length && !f.people.includes(c.assignee ? whoKey(c.assignee) : "none")) return false;
  if (f.labels.length && !c.labels.some((l) => f.labels.includes(l))) return false;
  if (f.prios.length && !f.prios.includes(c.priority)) return false;
  return true;
}

function cardHtml(c, col) {
  const p = S.prefs, lk = lockFor(c), other = lk && !lk.mine, mine = lk && lk.mine && S.open === c.id;
  const labels = (board().labels || []).reduce((m, l) => ((m[l.id] = l), m), {});
  const done = c.checklist.filter((x) => x.done).length;
  const late = c.due && c.due < today() && col.id !== lastCol();
  const cover = c.cover && S.thumbs[c.cover];
  if (c.cover && S.thumbs[c.cover] === undefined) loadThumb(c.cover);
  const tag = other ? `${lk.who}${lk.task ? " · " + lk.task : " is editing"}` : mine ? "You're editing" : "";
  const prio = PRIOS.find((x) => x[0] === c.priority) || PRIOS[2];
  const fresh = S.known && !S.known.has(c.id);
  return `<article class="kb-card ${other ? "held" : ""} ${mine ? "mine" : ""} ${S.drag === c.id ? "dragging" : ""} ${fresh ? "fresh" : ""}" draggable="${!other}"
      data-card="${esc(c.id)}" tabindex="0" aria-label="${esc(c.title)}" data-live-id="card-${esc(c.id)}">
    ${cover ? `<div class="kb-card-cover" style="background-image:url('${cover}')"></div>` : ""}
    <div class="kb-card-body">
      ${tag && !lk?.column ? `<div class="kb-tag">${svg(ICON.lock, 12)}<span>${esc(tag)}</span>${other && lk.by.kind === "ducky" ? esc(pct(lk)) : ""}</div>
        ${other && lk.by.kind === "ducky" ? `<div class="kb-bar c-purple" style="height:2px;margin-top:-2px"><i style="width:${pct(lk)}"></i></div>` : ""}` : ""}
      <div class="kb-card-title">${c.icon ? `<span class="kb-glyph">${esc(c.icon)}</span>` : ""}<span>${esc(c.title)}</span></div>
      ${p.kanban_show_desc && c.desc ? `<span class="kb-card-desc">${esc(c.desc)}</span>` : ""}
      ${p.kanban_show_labels && c.labels.length ? `<div class="kb-chips" style="gap:4px">${c.labels.map((id) => labels[id]).filter(Boolean)
        .map((l) => `<span class="kb-label c-${esc(l.color)}">${esc(l.name)}</span>`).join("")}</div>` : ""}
      <div class="kb-meta">
        <span class="mono">${esc(c.id)}</span>
        ${p.kanban_show_priority && (c.priority === "urgent" || c.priority === "high") ? `<span class="kb-prio p-${c.priority}">${prio[1]}</span>` : ""}
        ${p.kanban_show_due && c.due ? `<span class="${late ? "late" : ""}">${late ? "Overdue " : ""}${esc(fmtDate(c.due))}</span>` : ""}
        ${p.kanban_show_checklist && c.checklist.length ? `<span class="${done === c.checklist.length ? "done" : ""}">✓ ${done}/${c.checklist.length}</span>` : ""}
        ${p.kanban_show_comments && c.comments.length ? `<span>${svg(ICON.chat, 12, 1.3)}${c.comments.length}</span>` : ""}
        ${(c.attachments || []).length ? `<span>${svg(ICON.clip, 12, 1.3)}${c.attachments.length}</span>` : ""}
        <span class="kb-spacer"></span>
        ${p.kanban_show_assignee && c.assignee ? avatar(c.assignee) : ""}
      </div>
    </div>
  </article>`;
}

function columnHtml(col, ci) {
  const all = cards().filter((c) => c.colId === col.id), vis = all.filter(matches);
  const lk = ((S.v && S.v.locks) || []).find((l) => l.column && l.colId === col.id && !l.mine);
  const isOver = S.drag && S.over && S.over.col === col.id;
  const dragCard = S.drag && cardById(S.drag);
  const full = settings().enforceWip !== false && col.wip && dragCard && dragCard.colId !== col.id && all.length >= col.wip;
  const blocked = isOver && (lk || full);
  const count = col.wip ? `${all.length}/${col.wip}` : `${all.length}`;
  const cnt = col.wip && all.length > col.wip ? "over" : col.wip && all.length >= col.wip ? "at" : "";
  const menuOpen = S.menu === `col-${col.id}`;
  const items = vis.map((c) => `${isOver && !blocked && S.over.before === c.id && S.drag !== c.id ? '<div class="kb-drop-mark"></div>' : ""}${cardHtml(c, col)}`).join("");
  return `<section class="kb-col ${blocked ? "blocked" : isOver ? "over" : ""} ${lk ? "locked" : ""}" data-col="${esc(col.id)}" data-live-id="col-${esc(col.id)}">
    <div class="kb-col-head">
      <input class="kb-col-title" value="${esc(col.title)}" data-rename="${esc(col.id)}" aria-label="Column name" ${lk ? "disabled" : ""}>
      <span class="kb-col-count ${cnt}" title="${col.wip ? `WIP limit ${col.wip}` : "No WIP limit"}">${count}</span>
      <div style="position:relative">
        <button class="kb-icon-btn" data-menu="col-${esc(col.id)}" aria-label="Column menu" aria-expanded="${menuOpen}">${svg(ICON.dots)}</button>
        ${menuOpen ? `<div class="kb-drop" style="width:210px;padding:5px;gap:0">
          <div class="dk-row" style="padding:6px 9px;gap:8px"><span style="flex:1;font-weight:500">WIP limit</span>
            <span class="kb-stepper"><button data-wip="${esc(col.id)}" data-d="-1" aria-label="Lower WIP limit">−</button><span>${col.wip || "∞"}</span><button data-wip="${esc(col.id)}" data-d="1" aria-label="Raise WIP limit">+</button></span></div>
          <div class="kb-sep"></div>
          <button class="kb-menu-item" data-add="${esc(col.id)}">${svg(ICON.plus, 14)}Add card</button>
          <button class="kb-menu-item" data-move-col="${esc(col.id)}" data-d="-1" ${ci === 0 ? "disabled" : ""}>Move left</button>
          <button class="kb-menu-item" data-move-col="${esc(col.id)}" data-d="1" ${ci === board().columns.length - 1 ? "disabled" : ""}>Move right</button>
          <button class="kb-menu-item danger" data-del-col="${esc(col.id)}">${svg(ICON.trash, 14)}Delete column</button>
        </div>` : ""}
      </div>
    </div>
    ${lk ? `<div class="kb-lockbar"><div class="kb-lockbar-top">${svg(ICON.lock, 14)}<span style="flex:1">${esc(lk.who)}${lk.task ? " · " + esc(lk.task) : ""}</span><span>${esc(pct(lk))}</span></div>
      <div class="kb-bar c-purple"><i style="width:${pct(lk) || "0%"}"></i></div></div>` : ""}
    <div class="kb-cards">
      ${items}
      ${isOver && !blocked && !S.over.before ? '<div class="kb-drop-mark"></div>' : ""}
      ${!vis.length && S.adding !== col.id && !isOver ? `<div class="kb-empty">${S.q || S.filter.people.length + S.filter.labels.length + S.filter.prios.length ? "No matching cards" : "No cards yet"}</div>` : ""}
    </div>
    <div class="kb-col-foot">
      ${S.adding === col.id ? `<div class="kb-new"><textarea id="new-card" rows="2" placeholder="Card title, Enter to add" aria-label="New card title"></textarea>
        <div class="dk-row" style="gap:6px"><button class="dk-btn dk-btn--primary" data-submit-add="${esc(col.id)}">Add</button><button class="dk-btn dk-btn--ghost" data-cancel-add>Cancel</button></div></div>`
        : lk ? "" : `<button class="kb-add" data-add="${esc(col.id)}">${svg(ICON.plus)}Add card</button>`}
    </div>
  </section>`;
}

function render() {
  document.body.classList.toggle("comfortable", S.prefs.kanban_density === "comfortable");
  $("scope-label").textContent = (S.scope && S.scope.label) || "Local";
  const b = board();
  $("board-name").textContent = b ? b.name : "Kanban";
  $("board-mark").textContent = b ? (b.name || "?")[0].toUpperCase() : "K";
  const fc = S.filter.people.length + S.filter.labels.length + S.filter.prios.length;
  $("filter-count").textContent = fc; $("filter-count").classList.toggle("hidden", !fc);
  $("filter-btn").classList.toggle("on", !!fc);
  const acts = (S.v && S.v.activity) || [], seen = S.seen[S.boardId] || 0;
  const fresh = acts.filter((a) => a.at > seen).length;
  $("activity-count").textContent = fresh > 99 ? "99+" : fresh;
  $("activity-count").classList.toggle("hidden", !fresh || S.menu === "activity");
  renderDrops();
  if (!b) {
    setHTML($("main"), `<div class="dk-empty" style="margin:auto;max-width:420px"><div class="dk-empty__title">No boards yet</div>
      Make one from a template, or ask a ducky to plan your work into one.<div style="margin-top:12px"><button class="dk-btn dk-btn--primary" id="first-board">New board</button></div></div>`);
  } else {
    const draft = $("new-card") ? { value: $("new-card").value, focused: document.activeElement === $("new-card") } : null;
    const changed = setHTML($("main"), b.columns.map(columnHtml).join("") + `<button class="kb-add-col" id="add-col">${svg(ICON.plus)}Add column</button>`);
    if (changed && S.adding && $("new-card")) { $("new-card").value = draft ? draft.value : ""; if (!draft || draft.focused) $("new-card").focus(); }
    S.known = new Set(cards().map((c) => c.id));
  }
  renderModal();
}

function renderDrops() {
  const fd = $("filter-drop"), ad = $("activity-drop");
  fd.classList.toggle("hidden", S.menu !== "filter");
  ad.classList.toggle("hidden", S.menu !== "activity");
  if (S.menu === "filter" && board()) {
    const people = new Map([["none", { label: "Unassigned" }]]);
    cards().forEach((c) => c.assignee && people.set(whoKey(c.assignee), { label: whoLabel(c.assignee), by: c.assignee }));
    const shown = cards().filter(matches).length;
    setHTML(fd, `<div class="kb-field"><span class="caps">Assignee</span><div class="kb-chips">${[...people].map(([k, p]) =>
        `<button class="kb-chip ${S.filter.people.includes(k) ? "on" : ""}" data-f="people" data-v="${esc(k)}" style="padding-left:3px">${avatar(p.by)}${esc(p.label)}</button>`).join("")}</div></div>
      <div class="kb-field"><span class="caps">Labels</span><div class="kb-chips">${board().labels.map((l) =>
        `<button class="kb-chip ${S.filter.labels.includes(l.id) ? "on" : ""}" data-f="labels" data-v="${esc(l.id)}"><span class="kb-label c-${esc(l.color)}">${esc(l.name)}</span></button>`).join("")}</div></div>
      <div class="kb-field"><span class="caps">Priority</span><div class="kb-chips">${PRIOS.map(([id, name]) =>
        `<button class="kb-chip ${S.filter.prios.includes(id) ? "on" : ""}" data-f="prios" data-v="${id}"><span class="kb-prio p-${id}">${name}</span></button>`).join("")}</div></div>
      <div class="dk-row" style="justify-content:space-between;border-top:1px solid var(--border);padding-top:10px">
        <span class="muted">${shown} of ${cards().length} cards shown</span><button class="dk-btn dk-btn--ghost" id="clear-filter">Clear all</button></div>`);
  }
  if (S.menu === "activity") {
    const acts = (S.v && S.v.activity) || [];
    setHTML(ad, `<div class="caps" style="padding:8px 10px 6px">Activity</div>` + (acts.length ? acts.map((a) =>
      `<div class="kb-act">${avatar(a.by, "lg")}<span class="kb-act-text"><b>${esc(a.who)}</b> ${esc(a.text)}</span><span class="kb-act-time">${ago(a.at)}</span></div>`).join("")
      : '<div class="kb-empty">Nothing yet.</div>'));
  }
}

// ---------------------------------------------------------------- card modal

async function openCard(id) {
  if (S.drag) return;
  if (S.open && S.open !== id) await closeCard();
  const c = cardById(id); if (!c) return;
  const r = await rpc("lock", { board: S.boardId, card: id });
  S.open = id; S.openMine = !!r.ok; S.expired = false; S.modal = "card"; S.menu = ""; S.linkOpen = false;
  if (!r.ok) {
    const lk = lockFor(c);
    if (lk && lk.by.kind === "ducky" && settings().agentsYield) await rpc("ask_yield", { board: S.boardId, card: id });
  }
  (c.attachments || []).filter((a) => a.kind === "image" && a.path).forEach((a) => loadThumb(a.path));
  await loadView();
}
async function closeCard() {
  const id = S.open;
  S.open = ""; S.modal = ""; S.expired = false; S.menu = "";
  if (id && S.openMine) await rpc("unlock", { board: S.boardId, card: id });
  S.openMine = false;
  await loadView();
}
const edit = (fields) => act(rpc("update_card", { board: S.boardId, card: S.open, fields }));

async function loadThumb(path) {
  if (S.thumbs[path] !== undefined) return;
  S.thumbs[path] = "";
  const r = await rpc("attachment", { path });
  const att = cards().flatMap((c) => c.attachments || []).find((a) => a.path === path);
  if (r.ok) { S.thumbs[path] = `data:${(att && att.mime) || "image/png"};base64,${r.b64}`; render(); }
}

/** A dropdown trigger in the card's side panel, like the app's own pickers. */
function picker(id, ro, inner, cls = "") {
  return `<button class="kb-pick ${cls}" data-mmenu="${id}" aria-haspopup="listbox" aria-expanded="${S.menu === id}" ${ro ? 'aria-disabled="true"' : ""}>${inner}${svg(ICON.chev)}</button>`;
}
function popover(id, inner, cls = "") {
  return S.menu === id ? `<div class="kb-pop ${cls} ${F.menu !== id ? "anim" : ""}" role="listbox">${inner}</div>` : "";
}
const opt = (on, attrs, inner) => `<button class="kb-opt ${on ? "on" : ""}" role="option" aria-selected="${on}" ${attrs}>${inner}<span class="kb-opt-check">✓</span></button>`;

function calendar(c) {
  const [y, m] = (S.calMonth || (c.due || today()).slice(0, 7)).split("-").map(Number);
  const first = new Date(y, m - 1, 1), off = (first.getDay() + 6) % 7, t = today();
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(y, m - 1, 1 - off + i), di = iso(d);
    const cls = [d.getMonth() !== m - 1 ? "out" : "", di === t ? "today" : "", di === c.due ? "sel" : ""].join(" ");
    return `<button class="${cls}" data-due="${di}">${d.getDate()}</button>`;
  }).join("");
  return `<div class="kb-quick">${[["Today", 0], ["Tomorrow", 1], ["Next week", 7]].map(([l, n]) => `<button data-due="${addDays(n)}">${l}</button>`).join("")}
      ${c.due ? '<button data-due="">Clear</button>' : ""}</div>
    <div class="kb-cal-head"><button class="kb-icon-btn" data-cal="-1" aria-label="Previous month">‹</button>
      <b>${first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b>
      <button class="kb-icon-btn" data-cal="1" aria-label="Next month">›</button></div>
    <div class="kb-cal">${["M", "T", "W", "T", "F", "S", "S"].map((l) => `<span>${l}</span>`).join("")}${cells}</div>`;
}

function cardModal() {
  const c = cardById(S.open); if (!c) return "";
  const b = board(), lk = lockFor(c), other = lk && !lk.mine, ro = !S.openMine || !!other;
  const labels = b.labels.reduce((m, l) => ((m[l.id] = l), m), {});
  const done = c.checklist.filter((x) => x.done).length, total = c.checklist.length;
  const left = lk && lk.mine ? Math.max(0, Math.ceil(lk.touched + lk.lease - Date.now() / 1000)) : 0;
  const late = c.due && c.due < today() && c.colId !== lastCol();
  const dis = ro ? "disabled" : "";
  const asgKey = c.assignee ? whoKey(c.assignee) : "";
  const people = [...S.people];
  if (c.assignee && !people.find((p) => whoKey(p) === asgKey)) people.push(c.assignee);
  const prio = PRIOS.find((p) => p[0] === c.priority) || PRIOS[2];
  const ducky = other && lk.by.kind === "ducky";

  const banner = other ? `<div class="kb-banner">
      <div class="kb-banner-title">${svg(ICON.warn, 14)}<span style="flex:1">${lk.column ? `${esc(lk.who)} locked ${esc(colTitle(c.colId))}` : `${ducky ? "Ducky" : "Locked"} · ${esc(lk.who)}`}</span>${ducky ? esc(pct(lk)) : ""}</div>
      ${ducky ? `<div class="kb-bar c-purple"><i style="width:${pct(lk) || "0%"}"></i></div>` : ""}
      <div class="dk-row" style="flex-wrap:wrap;gap:10px;align-items:center"><span style="flex:1 1 300px;line-height:1.5">${esc(lk.who)} is ${esc((lk.task || "editing").toLowerCase())} ${lk.column ? "and has the whole column locked. This card is read-only until it finishes." : `on this card. Read-only until ${ducky ? "it finishes or yields" : "they finish"}. You can still comment.`}</span>
        <div class="dk-row" style="gap:6px"><button class="dk-btn dk-btn--secondary" id="ask-yield">${ducky ? "Ask ducky to yield" : "Ask to finish up"}</button>
        ${settings().allowForce !== false ? '<button class="dk-btn dk-btn--primary" id="force">Force unlock</button>' : ""}</div></div></div>`
    : S.openMine && lk ? `<div class="kb-banner mine"><span class="kb-banner-title">Locked to you</span><span class="muted" style="flex:1">Others see read-only · releases after ${left}s idle</span>
        ${lk.yieldAsked ? `<span class="dk-badge dk-badge--warn">${esc(whoLabel(lk.yieldAsked.by))} asked you to finish up</span>` : ""}</div>`
    : S.expired ? '<div class="kb-banner idle"><span style="flex:1">Your lock ended from inactivity.</span><button class="dk-btn dk-btn--primary" id="resume">Resume editing</button></div>' : "";

  const atts = (c.attachments || []).map((a) => {
    const thumb = a.kind === "image" && a.path ? S.thumbs[a.path] : "";
    const host = a.url ? (() => { try { return new URL(a.url).hostname.replace(/^www\./, ""); } catch { return ""; } })() : "";
    const ext = (a.name.includes(".") ? a.name.split(".").pop() : "file").slice(0, 4).toUpperCase();
    const face = a.url ? `<a class="kb-att-thumb" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" title="Open link"><span style="display:grid;justify-items:center;gap:6px">${svg(ICON.link, 22)}<span style="font:500 11px var(--font-ui)">${esc(host)}</span></span></a>`
      : `<button class="kb-att-thumb" data-att-open="${esc(a.id)}" title="${a.kind === "file" ? "Download" : "Preview"}" style="${thumb ? `background-image:url('${thumb}')` : ""}">${thumb ? "" : `<span class="kb-att-ext">${esc(ext)}</span>`}</button>`;
    return `<div class="kb-att">${face}<div class="kb-att-body"><span style="font-weight:500">${esc(a.name)}</span>
      <span class="muted" style="font-size:10.5px">${esc([a.url ? "Link" : a.kind === "image" ? "Image" : a.kind === "video" ? "Video" : ext, a.size ? `${Math.max(1, Math.round(a.size / 1024))} KB` : "", whoLabel(a.by)].filter(Boolean).join(" · "))}</span>
      ${ro ? "" : `<div class="dk-row" style="gap:8px;padding-top:3px">${a.kind === "image" && a.path ? `<button class="kb-link" data-cover="${esc(a.path)}">${c.cover === a.path ? "Cover ✓" : "Make cover"}</button>` : ""}<button class="kb-link quiet" data-att-del="${esc(a.id)}">Remove</button></div>`}</div></div>`;
  }).join("");

  const statusPick = picker("m-status", ro, `<span class="kb-swatch-sm"></span><span class="kb-pick-text">${esc(colTitle(c.colId))}</span>`);
  const statusPop = popover("m-status", b.columns.map((col) => {
    const n = cards().filter((x) => x.colId === col.id).length;
    return opt(col.id === c.colId, `data-set-status="${esc(col.id)}"`, `<span style="flex:1">${esc(col.title)}</span><span class="kb-opt-meta">${col.wip ? `${n}/${col.wip}` : ""}</span>`);
  }).join(""));
  const asgPick = picker("m-assignee", ro, `${avatar(c.assignee)}<span class="kb-pick-text">${c.assignee ? esc(whoLabel(c.assignee)) : "Unassigned"}</span>`, c.assignee ? "" : "empty");
  const asgPop = popover("m-assignee", opt(!c.assignee, 'data-set-assignee=""', `${avatar(null)}<span style="flex:1">Unassigned</span>`) +
    people.map((p) => opt(whoKey(p) === asgKey, `data-set-assignee="${esc(whoKey(p))}"`,
      `${avatar(p)}<span style="flex:1">${esc(whoLabel(p))}</span>${p.kind === "ducky" ? '<span class="kb-tag-ducky">DUCKY</span>' : ""}`)).join(""));
  const prioPick = picker("m-priority", ro, `<span class="kb-swatch-sm p-${prio[0]}"></span><span class="kb-pick-text">${prio[1]}</span>`);
  const prioPop = popover("m-priority", PRIOS.map(([id, name]) => opt(id === c.priority, `data-set-prio="${id}"`,
    `<span class="kb-swatch-sm p-${id}"></span><span style="flex:1">${name}</span>`)).join(""));
  const duePick = picker("m-due", ro, `${svg(ICON.cal)}<span class="kb-pick-text">${c.due ? `${late ? "Overdue · " : ""}${esc(fmtDate(c.due, true))}` : "No due date"}</span>`, late ? "late" : c.due ? "" : "empty");
  const duePop = popover("m-due", calendar(c), "wide up");
  const lblPick = picker("m-labels", ro, c.labels.length ? c.labels.map((id) => labels[id]).filter(Boolean)
    .map((l) => `<span class="kb-label c-${esc(l.color)}" style="font-size:11px;padding:2px 7px">${esc(l.name)}</span>`).join("") + '<span class="kb-spacer"></span>'
    : '<span class="kb-pick-text">None</span>', c.labels.length ? "" : "empty");
  const lblPop = popover("m-labels", b.labels.length ? b.labels.map((l) => {
    const on = c.labels.includes(l.id);
    return `<button class="kb-opt ${on ? "on" : ""}" role="option" aria-selected="${on}" data-label="${esc(l.id)}"><span class="kb-lbl-box">${on ? "✓" : ""}</span><span class="kb-swatch-sm c-${esc(l.color)}"></span><span style="flex:1">${esc(l.name)}</span></button>`;
  }).join("") : '<span class="muted" style="padding:7px 9px">No labels. Add some in board settings.</span>');
  const glyphPop = S.menu === "m-icon" ? `<div class="kb-pop wide ${F.menu !== "m-icon" ? "anim" : ""}" style="left:0;right:auto;width:244px">
      <span class="caps" style="padding:0 2px">Icon</span><div class="kb-glyphs">${GLYPHS.map((g) => `<button class="${c.icon === g ? "on" : ""}" data-glyph="${g}">${g}</button>`).join("")}</div>
      ${c.icon ? `<div class="kb-sep"></div><button class="kb-menu-item danger" data-glyph="">Remove icon</button>` : ""}</div>` : "";

  return `<div class="kb-overlay ${F.modalKey !== "card:" + c.id ? "kb-enter" : ""}" data-close-modal><div class="kb-modal" role="dialog" aria-modal="true" aria-label="${esc(c.title)}" data-live-id="modal-${esc(c.id)}">
    <div class="kb-modal-head"><span class="kb-pill">${esc(c.id)}</span><span class="muted">in ${esc(colTitle(c.colId))} · created ${ago(c.createdAt)} ago by ${esc(whoLabel(c.createdBy))}</span>
      <span class="kb-spacer"></span>${ro ? "" : `<button class="kb-text-btn danger" id="del-card">Delete</button>`}
      <button class="kb-icon-btn" data-close aria-label="Close (Esc)" title="Close (Esc)" style="width:28px;height:28px">${svg(ICON.close)}</button></div>
    ${c.cover && S.thumbs[c.cover] ? `<div class="kb-cover" style="background-image:url('${S.thumbs[c.cover]}')">${ro ? "" : '<button class="kb-cover-btn" data-cover-remove>Remove cover</button>'}</div>` : ""}
    ${banner}
    <div class="kb-split">
      <div class="kb-left">
        <div class="dk-row" style="align-items:flex-start;gap:10px">
          <div style="position:relative;flex:none"><button class="kb-glyph-btn ${c.icon ? "set" : ""}" data-mmenu="m-icon" aria-label="Card icon" title="Card icon" ${ro ? 'aria-disabled="true"' : ""}>${c.icon ? esc(c.icon) : svg(ICON.image)}</button>${glyphPop}</div>
          <textarea class="kb-title-input" id="m-title" rows="2" ${dis} aria-label="Title">${esc(c.title)}</textarea>
        </div>
        <div class="kb-field"><span class="caps">Description</span><textarea class="kb-desc" id="m-desc" rows="3" ${dis} placeholder="Add more detail…">${esc(c.desc)}</textarea></div>
        <div class="kb-field" style="gap:4px">
          <div class="kb-check-head"><span class="caps">Checklist</span><div class="kb-bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div><b style="font-size:11.5px">${total ? `${done}/${total}` : ""}</b></div>
          ${c.checklist.map((it) => `<div class="kb-check ${it.done ? "done" : ""}">
            <button class="kb-tick ${it.done ? "on" : ""}" data-ck-toggle="${esc(it.id)}" role="checkbox" aria-checked="${it.done}" aria-label="Done" ${dis}>${svg(ICON.check, 14, 2.2)}</button>
            <input value="${esc(it.text)}" data-ck-text="${esc(it.id)}" ${dis} aria-label="Checklist item">
            ${ro ? "" : `<button class="kb-icon-btn" data-ck-del="${esc(it.id)}" aria-label="Remove item">${svg(ICON.close, 14)}</button>`}</div>`).join("")}
          ${ro ? "" : '<input class="kb-new-item" id="m-new-item" placeholder="+ Add an item" aria-label="New checklist item">'}
        </div>
        <div class="kb-dropzone" id="att-zone">
          <div class="dk-row" style="gap:6px"><span class="caps" style="flex:1">Attachments ${(c.attachments || []).length || ""}</span>
            ${ro ? "" : `<button class="dk-btn dk-btn--secondary" id="upload">${svg(ICON.upload, 14)} Upload</button><button class="dk-btn dk-btn--secondary" id="link-toggle">${svg(ICON.link, 14)} Link</button>`}</div>
          ${S.linkOpen && !ro ? '<div class="dk-row" style="gap:6px;animation:kb-slide .18s"><input class="kb-input" id="link-draft" placeholder="Paste a link: website, video or image URL" style="flex:1;border-color:var(--accent)"><button class="dk-btn dk-btn--primary" id="add-link">Add</button></div>' : ""}
          ${atts ? `<div class="kb-atts">${atts}</div>` : S.linkOpen ? "" : `<div class="kb-empty">${ro ? "No attachments" : "Drop files here, or add files and links"}</div>`}
        </div>
        <div class="kb-field" style="gap:10px"><span class="caps">Comments ${c.comments.length || ""}</span>
          ${c.comments.map((m) => `<div class="kb-comment">${avatar(m.by, "lg")}<div style="min-width:0;display:flex;flex-direction:column;gap:2px"><span><b style="font-size:12.5px">${esc(whoLabel(m.by))}</b> <span class="muted">${ago(m.at)}</span></span><div class="kb-comment-text">${esc(m.text)}</div></div></div>`).join("")}
          <div class="kb-composer"><textarea id="m-comment" rows="1" placeholder="Add a comment… (works on locked cards)" aria-label="Comment"></textarea>
            <button class="kb-send" id="post-comment" aria-label="Post comment" title="Post">${svg(ICON.up, 16, 1.8)}</button></div>
        </div>
      </div>
      <div class="kb-right">
        <div class="kb-field"><span class="caps">Status</span><div class="kb-field-wrap">${statusPick}${statusPop}</div></div>
        <div class="kb-field"><span class="caps">Assignee</span><div class="kb-field-wrap">${asgPick}${asgPop}</div></div>
        <div class="kb-field"><span class="caps">Priority</span><div class="kb-field-wrap">${prioPick}${prioPop}</div></div>
        <div class="kb-field"><span class="caps">Due date</span><div class="kb-field-wrap">${duePick}${duePop}</div></div>
        <div class="kb-field"><span class="caps">Labels</span><div class="kb-field-wrap">${lblPick}${lblPop}</div></div>
        ${c.updatedBy ? `<span class="muted" style="font-size:11.5px;line-height:1.5;padding-top:4px">Last change by ${esc(whoLabel(c.updatedBy))}, ${ago(c.updatedAt)} ago</span>` : ""}
      </div>
    </div>
  </div></div>`;
}

// ---------------------------------------------------------------- settings + picker

function toggle(id, on, title, hint) {
  return `<div class="kb-row" style="padding:12px 16px"><span class="kb-row-text"><b>${title}</b><span class="muted" style="font-size:12px">${hint}</span></span>
    <button class="kb-toggle" role="switch" aria-checked="${!!on}" aria-label="${esc(title)}" data-setting="${id}"></button></div>`;
}
function settingsModal() {
  const b = board(); if (!b) return "";
  const st = settings();
  const pages = [["general", "General"], ["columns", "Columns & labels"], ["duckies", "Duckies & locking"]];
  let body = "";
  if (S.page === "general") {
    body = `<div class="kb-box" style="padding:12px 16px"><label class="kb-field"><b>Board name</b><input class="kb-input" id="s-name" value="${esc(b.name)}"></label></div>
      <div class="kb-box"><div class="kb-row" style="padding:12px 16px"><span class="kb-row-text"><b>How cards look</b><span class="muted" style="font-size:12px">Density and the fields on each card are yours, in Settings → Kanban.</span></span></div>
      <div class="kb-row" style="padding:12px 16px"><span class="kb-row-text"><b>Local or a team</b><span class="muted" style="font-size:12px">Where the boards are saved is the plugin's data choice: the bar above this panel, or Plugins → Kanban → Data. Now: ${esc((S.scope && S.scope.label) || "Local")}.</span></span></div></div>
      <div class="kb-box" style="border-color:var(--red)"><div class="kb-row" style="padding:12px 16px"><span class="kb-row-text"><b>Delete board</b><span class="muted" style="font-size:12px">Removes its cards and activity for everyone who shares it.</span></span><button class="dk-btn dk-btn--danger" id="s-delete">Delete board</button></div></div>`;
  } else if (S.page === "columns") {
    body = `<div class="kb-box">${toggle("enforceWip", st.enforceWip, "Enforce WIP limits", "Refuse drops and new cards when a column is full")}</div>
      <div class="kb-field"><span class="caps">Columns</span><div class="kb-box">${b.columns.map((c, i) => `<div class="kb-row">
        <input class="kb-plain" value="${esc(c.title)}" data-rename="${esc(c.id)}" aria-label="Column name"><span class="muted" style="font-size:11.5px">WIP</span>
        <span class="kb-stepper"><button data-wip="${esc(c.id)}" data-d="-1" aria-label="Lower WIP limit">−</button><span>${c.wip || "∞"}</span><button data-wip="${esc(c.id)}" data-d="1" aria-label="Raise WIP limit">+</button></span>
        <button class="kb-icon-btn" data-move-col="${esc(c.id)}" data-d="-1" ${i ? "" : "disabled"} aria-label="Move left">←</button>
        <button class="kb-icon-btn" data-move-col="${esc(c.id)}" data-d="1" ${i < b.columns.length - 1 ? "" : "disabled"} aria-label="Move right">→</button>
        <button class="kb-icon-btn" data-del-col="${esc(c.id)}" aria-label="Delete column" style="color:var(--red)">${svg(ICON.trash)}</button></div>`).join("")}
      <button class="kb-add" id="add-col-2" style="padding:10px 16px;border-top:1px solid var(--border);border-radius:0">${svg(ICON.plus)}Add column</button></div></div>
      <div class="kb-field"><span class="caps">Labels</span><div class="kb-box">${b.labels.map((l) => `<div class="kb-row">
        <button class="kb-swatch c-${esc(l.color)}" data-hue="${esc(l.id)}" aria-label="Change color" title="Change color"></button>
        <input class="kb-plain" value="${esc(l.name)}" data-label-name="${esc(l.id)}" aria-label="Label name" style="color:var(--${esc(l.color)})">
        <span class="muted mono" style="font-size:11.5px">${cards().filter((c) => c.labels.includes(l.id)).length} cards</span>
        <button class="kb-icon-btn" data-del-label="${esc(l.id)}" aria-label="Delete label" style="color:var(--red)">${svg(ICON.trash)}</button></div>`).join("")}
      <button class="kb-add" id="add-label" style="padding:10px 16px;border-top:1px solid var(--border);border-radius:0">${svg(ICON.plus)}Add label</button></div></div>`;
  } else {
    body = `<div class="kb-box">${toggle("agentsPaused", !st.agentsPaused, "Duckies can work here", "Off: every ducky's change to this board is refused")}
      ${toggle("agentColLocks", st.agentColLocks, "Duckies can lock whole columns", "A ducky sorting the backlog holds the column while it works")}
      ${toggle("agentsYield", st.agentsYield, "Duckies yield to people", "Opening a card a ducky holds makes it let go at once")}
      ${toggle("allowForce", st.allowForce, "Allow force unlock", "Take over a card or column held by someone else")}</div>
      <div class="kb-box"><div class="kb-row" style="padding:12px 16px;flex-wrap:wrap"><span class="kb-row-text"><b>Idle timeout</b><span class="muted" style="font-size:12px">A person's lock on an open card ends after this much inactivity</span></span>
        <span class="kb-seg">${[[15, "15s"], [30, "30s"], [60, "1m"], [300, "5m"]].map(([v, l]) => `<button data-timeout="${v}" aria-pressed="${st.lockTimeout === v}" class="mono">${l}</button>`).join("")}</span></div></div>
      <div class="kb-box" style="padding:12px 16px;border-color:var(--blue);background:var(--blue-dim)"><span class="caps" style="color:var(--blue)">How locking works</span>
        <p style="margin:6px 0 0;line-height:1.6">Opening a card locks it to you; everyone else, people and duckies, sees it read-only until you close it or go idle. A ducky's change holds the card for two minutes and says whose ducky it is: "Builder (Ilya's ducky)", never just Ilya. Comments stay open on locked cards.</p></div>`;
  }
  return `<div class="kb-overlay center ${F.modalKey !== "settings" ? "kb-enter" : ""}" data-close-modal><div class="kb-modal kb-wide" role="dialog" aria-modal="true" aria-label="Board settings">
    <nav class="kb-nav"><b style="padding:4px 10px 12px;font-size:15px">Settings</b>${pages.map(([id, l]) =>
      `<button class="dk-nav-item" data-page="${id}" ${S.page === id ? 'aria-current="page"' : ""}>${l}</button>`).join("")}
      <span class="kb-spacer"></span><span class="muted" style="font-size:11px;padding:8px 10px 0;line-height:1.5">Changes save automatically and reach everyone on the board</span></nav>
    <div class="kb-pane"><div class="dk-row" style="padding:14px 16px 10px 24px"><b style="flex:1;font-size:21px">${(pages.find((p) => p[0] === S.page) || pages[0])[1]}</b>
      <button class="kb-icon-btn" data-close aria-label="Close (Esc)" style="width:28px;height:28px">${svg(ICON.close)}</button></div><div class="kb-pane-body" data-page-body="${S.page}">${body}</div></div>
  </div></div>`;
}
function bars(counts, h = 30) {
  const max = Math.max(1, ...counts);
  return `<div class="kb-bars" style="height:${h}px">${counts.map((k) => `<i class="${k ? "full" : ""}" style="height:${Math.max(3, Math.round((k / max) * h))}px"></i>`).join("")}</div>`;
}
function pickerModal() {
  const tp = S.templates.find((t) => t.id === S.tpl) || S.templates[0] || { columns: [], name: "" };
  return `<div class="kb-overlay ${F.modalKey !== "picker" ? "kb-enter" : ""}" data-close-modal style="padding-top:8vh"><div class="kb-modal" role="dialog" aria-modal="true" aria-label="Boards" style="max-width:780px;max-height:84vh;overflow:hidden">
    <div class="dk-row" style="padding:14px 14px 4px 20px"><b style="flex:1;font-size:19px">Boards</b><button class="kb-icon-btn" data-close aria-label="Close (Esc)" style="width:28px;height:28px">${svg(ICON.close)}</button></div>
    <div class="dk-row muted" style="padding:6px 20px 0;gap:8px"><span class="kb-dot"></span>${S.scope && S.scope.kind === "shared"
      ? `Shared with ${esc(S.scope.label)}. Teammates and their duckies work on these boards live; locks say who holds what.`
      : "Saved on this PC for this account. Share them with a team from the bar above this panel."}</div>
    <div style="padding:14px 20px 20px;display:flex;flex-direction:column;gap:14px;overflow-y:auto">
      <div class="kb-grid">${S.boards.map((x) => `<div class="kb-bcard ${x.id === S.boardId ? "open" : ""}" data-board="${esc(x.id)}" tabindex="0" role="button" aria-label="Open ${esc(x.name)}">
        <div class="dk-row" style="gap:8px"><span class="kb-mark" style="width:20px;height:20px;font-size:10px">${esc((x.name || "?")[0].toUpperCase())}</span><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.name)}</b>
          ${x.id === S.boardId ? '<span class="dk-badge dk-badge--accent">Open</span>' : ""}
          <button class="kb-icon-btn" data-del-board="${esc(x.id)}" aria-label="Delete ${esc(x.name)}" title="Delete board">${svg(ICON.trash, 14)}</button></div>
        ${bars(x.columns.map((c) => c.count))}
        <div style="display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--border)">
          ${x.editing.length ? `<span style="font-size:11px;color:var(--accent);display:flex;align-items:center;gap:5px"><span class="kb-dot"></span>${esc(x.editing.join(", "))} editing</span>` : ""}
          <span class="muted" style="font-size:11.5px">${x.columns.length} columns · ${x.cards} card${x.cards === 1 ? "" : "s"} · ${x.id === S.boardId ? "open now" : `edited ${ago(x.updatedAt)} ago`}</span></div>
      </div>`).join("")}</div>
      <div class="kb-box" style="padding:14px;display:flex;flex-direction:column;gap:12px;background:var(--bg-panel)">
        <div class="dk-row"><b style="flex:1">New board in ${esc((S.scope && S.scope.label) || "Local")}</b><span class="muted" style="font-size:11.5px">Pick a template</span></div>
        <div class="kb-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${S.templates.map((t) =>
          `<button class="kb-tpl ${t.id === S.tpl ? "on" : ""}" data-tpl="${esc(t.id)}">${bars(t.columns.map((_, i) => t.cards.filter((x) => x === i).length), 22)}
            <b style="font-size:12.5px">${esc(t.name)}</b><span class="muted" style="font-size:11px;line-height:1.4">${esc(t.desc)}</span></button>`).join("")}</div>
        <div class="kb-chips" style="align-items:center"><span class="muted" style="font-size:11px;margin-right:4px">Columns</span>${tp.columns.map((c) => `<span class="kb-pill" style="font-family:var(--font-ui)">${esc(c.title)}${c.wip ? ` · ${c.wip}` : ""}</span>`).join("")}</div>
        <div class="dk-row" style="gap:8px"><input class="kb-input" id="new-board-name" placeholder="Board name (default: ${esc(tp.name)})" style="flex:1"><button class="dk-btn dk-btn--primary" id="create-board">Create board</button></div>
      </div>
    </div>
  </div></div>`;
}

function renderModal() {
  const m = $("modal");
  const keep = document.activeElement && m.contains(document.activeElement) && /^(m-title|m-desc|m-comment|m-new-item|link-draft|new-board-name|s-name)$/.test(document.activeElement.id)
    ? { id: document.activeElement.id, value: document.activeElement.value, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  const scroll = m.querySelector(".kb-overlay")?.scrollTop || 0;
  let html = S.modal === "card" ? cardModal() : S.modal === "settings" ? settingsModal() : S.modal === "picker" ? pickerModal() : "";
  if (S.lightbox) html += `<div class="kb-lightbox" data-close-lightbox>${S.lightbox.kind === "video"
    ? `<video src="${S.lightbox.src}" controls autoplay></video>` : `<img src="${S.lightbox.src}" alt="${esc(S.lightbox.name)}">`}
    <div class="dk-row" style="gap:12px"><span>${esc(S.lightbox.name)}</span><button class="dk-btn dk-btn--secondary" data-close-lightbox>Close</button></div></div>`;
  if (setHTML(m, html)) {
    const ov = m.querySelector(".kb-overlay"); if (ov) ov.scrollTop = scroll;
    if (keep && $(keep.id)) { const el = $(keep.id); el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ } }
  }
  F.modalKey = S.modal === "card" ? `card:${S.open}` : S.modal;
  F.menu = S.menu;
  document.body.dataset.liveView = S.modal === "card" ? `${S.boardId}:${S.open}` : S.boardId;
}

// ---------------------------------------------------------------- board edits

async function saveColumns(cols) { await act(rpc("update_board", { board: S.boardId, columns: cols })); }
async function saveLabels(labels) { await act(rpc("update_board", { board: S.boardId, labels })); }
async function saveSettings(patch) { await act(rpc("update_board", { board: S.boardId, settings: patch })); }
const cols = () => board().columns.map((c) => ({ ...c }));

function upload(files) {
  [...(files || [])].forEach((f) => {
    if (f.size > 15 * 1024 * 1024) return toast(`${f.name} is over 15 MB. Add it as a link instead.`);
    const r = new FileReader();
    r.onload = async () => {
      const b64 = String(r.result).split(",", 2)[1] || "";
      const out = await act(rpc("attach", { board: S.boardId, card: S.open, name: f.name, b64, mime: f.type || "" }), `Attached ${f.name}`);
      if (out && f.type.startsWith("image/")) (cardById(S.open)?.attachments || []).forEach((a) => a.path && a.kind === "image" && loadThumb(a.path));
    };
    r.readAsDataURL(f);
  });
}
function cardLocked() {
  const c = cardById(S.open), lk = c && lockFor(c);
  if (S.openMine && !(lk && !lk.mine)) return false;
  toast(lk && !lk.mine ? `Locked by ${lk.who}` : "Read-only. Resume editing first.");
  return true;
}

// ---------------------------------------------------------------- events

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-card], [data-board], [data-close-modal], [data-close-lightbox], a");
  if (!t) { if (S.menu) { S.menu = ""; render(); } return; }
  const d = t.dataset;
  if (d.closeLightbox !== undefined) { if (e.target === t || t.tagName === "BUTTON") { S.lightbox = null; renderModal(); } return; }
  if (d.closeModal !== undefined) {
    if (e.target === t) return S.modal === "card" ? closeCard() : ((S.modal = ""), (S.menu = ""), render());
    if (S.menu) { S.menu = ""; renderModal(); }  // a click on the modal itself closes its dropdown
    return;
  }
  if (S.menu && !d.menu && !d.mmenu && !t.closest(".kb-pop, .kb-drop")) S.menu = "";  // any other button closes an open dropdown
  if (d.close !== undefined) return S.modal === "card" ? closeCard() : ((S.modal = ""), render());
  if (t.id === "open-picker" || t.id === "first-board") { S.modal = "picker"; S.menu = ""; return render(); }
  if (t.id === "settings-btn") { if (board()) { S.modal = "settings"; S.menu = ""; render(); } return; }
  if (t.id === "filter-btn") { S.menu = S.menu === "filter" ? "" : "filter"; return render(); }
  if (t.id === "activity-btn") {
    S.menu = S.menu === "activity" ? "" : "activity";
    const latest = Math.max(0, ...(((S.v && S.v.activity) || []).map((a) => a.at)));
    S.seen[S.boardId] = latest; call("prefs.set", { id: "seen", value: S.seen }).catch(() => {});
    return render();
  }
  if (d.f) { const arr = S.filter[d.f]; S.filter[d.f] = arr.includes(d.v) ? arr.filter((x) => x !== d.v) : [...arr, d.v]; return render(); }
  if (t.id === "clear-filter") { S.filter = { people: [], labels: [], prios: [] }; return render(); }
  if (d.menu) { S.menu = S.menu === d.menu ? "" : d.menu; return render(); }
  if (d.mmenu) {
    if (t.getAttribute("aria-disabled") === "true") return cardLocked();
    if (d.mmenu === "m-due" && S.menu !== "m-due") S.calMonth = (cardById(S.open)?.due || today()).slice(0, 7);
    S.menu = S.menu === d.mmenu ? "" : d.mmenu;
    return renderModal();
  }
  if (d.add) { S.adding = d.add; S.menu = ""; return render(); }
  if (d.cancelAdd !== undefined) { S.adding = ""; return render(); }
  if (d.submitAdd) return submitAdd(d.submitAdd);
  if (d.wip) { const c = cols(); const x = c.find((y) => y.id === d.wip); x.wip = Math.max(0, (x.wip || 0) + Number(d.d)); return saveColumns(c); }
  if (d.moveCol) { const c = cols(), i = c.findIndex((y) => y.id === d.moveCol), j = i + Number(d.d); if (j < 0 || j >= c.length) return; [c[i], c[j]] = [c[j], c[i]]; S.menu = ""; return saveColumns(c); }
  if (d.delCol) {
    S.menu = "";
    if (board().columns.length <= 1) return toast("A board needs at least one column.");
    const n = cards().filter((c) => c.colId === d.delCol).length;
    if (!(await confirmBox(`Delete ${colTitle(d.delCol)}?${n ? ` Its ${n} card${n === 1 ? "" : "s"} move to the first column.` : ""}`, "Delete column"))) return render();
    return saveColumns(cols().filter((c) => c.id !== d.delCol));
  }
  if (t.id === "add-col" || t.id === "add-col-2") return saveColumns([...cols(), { title: "New column", wip: 0 }]);
  if (t.id === "add-label") return saveLabels([...board().labels, { name: "New label", color: COLORS[board().labels.length % COLORS.length] }]);
  if (d.hue) return saveLabels(board().labels.map((l) => (l.id === d.hue ? { ...l, color: COLORS[(COLORS.indexOf(l.color) + 1) % COLORS.length] } : l)));
  if (d.delLabel) return saveLabels(board().labels.filter((l) => l.id !== d.delLabel));
  if (d.setting) {
    const key = d.setting, on = t.getAttribute("aria-checked") === "true";
    t.setAttribute("aria-checked", String(!on));  // flip at once: the save follows
    return saveSettings({ [key]: key === "agentsPaused" ? on : !on });  // "Duckies can work here" is the inverse of paused
  }
  if (d.timeout) return saveSettings({ lockTimeout: Number(d.timeout) });
  if (d.page) { S.page = d.page; return render(); }
  if (t.id === "s-delete" || d.delBoard) {
    const id = d.delBoard || S.boardId, x = S.boards.find((y) => y.id === id) || {};
    e.stopPropagation();
    if (!(await confirmBox(`Delete ${x.name || "this board"} with all its cards? Everyone who shares it loses it.`, "Delete board"))) return;
    const r = await rpc("delete_board", { board: id });
    if (!r.ok) return toast(r.error);
    if (id === S.boardId) { S.boardId = ""; if (S.modal === "settings") S.modal = ""; }
    toast(`Deleted ${x.name || "the board"}`);
    return loadBoards();
  }
  if (d.board) { S.modal = ""; return selectBoard(d.board); }
  if (d.tpl) { S.tpl = d.tpl; return renderModal(); }
  if (t.id === "create-board") {
    const r = await rpc("create_board", { name: $("new-board-name").value.trim(), template: S.tpl });
    if (!r.ok) return toast(r.error);
    S.modal = ""; await loadBoards(); return selectBoard(r.board.id);
  }
  if (d.card) return openCard(d.card);
  // card modal
  if (t.id === "ask-yield") { const r = await rpc("ask_yield", { board: S.boardId, card: S.open }); toast(r.ok ? (r.released ? `${r.who || "They"} let go.` : `Asked ${r.who} to finish up.`) : r.error); return loadView(); }
  if (t.id === "force") {
    if (!(await confirmBox("Take this card over? Whoever holds it loses their lock.", "Force unlock", "Take over"))) return;
    const r = await rpc("force_unlock", { board: S.boardId, card: S.open });
    if (!r.ok) return toast(r.error);
    S.openMine = true; return loadView();
  }
  if (t.id === "resume") { const r = await rpc("lock", { board: S.boardId, card: S.open }); if (!r.ok) return toast(r.error); S.openMine = true; S.expired = false; return loadView(); }
  if (t.id === "del-card") {
    if (!(await confirmBox("Delete this card? Revert in Changes brings it back.", "Delete card"))) return;
    const r = await rpc("delete_card", { board: S.boardId, card: S.open });
    if (!r.ok) return toast(r.error);
    S.open = ""; S.openMine = false; S.modal = ""; toast("Card deleted"); return loadView();
  }
  if (d.setStatus !== undefined) { S.menu = ""; if (cardLocked()) return; return act(rpc("move_card", { board: S.boardId, card: S.open, column: d.setStatus })); }
  if (d.setAssignee !== undefined) {
    S.menu = ""; if (cardLocked()) return;
    const c = cardById(S.open), p = [...S.people, c.assignee].filter(Boolean).find((x) => whoKey(x) === d.setAssignee);
    return edit({ assignee: p || null });
  }
  if (d.setPrio) { S.menu = ""; if (cardLocked()) return; return edit({ priority: d.setPrio }); }
  if (d.due !== undefined) { S.menu = ""; if (cardLocked()) return; return edit({ due: d.due }); }
  if (d.cal) { const [y, m] = S.calMonth.split("-").map(Number); S.calMonth = iso(new Date(y, m - 1 + Number(d.cal), 1)).slice(0, 7); return renderModal(); }
  if (d.glyph !== undefined) { S.menu = ""; if (cardLocked()) return; return edit({ icon: d.glyph }); }
  if (d.ckToggle) { if (cardLocked()) return; t.classList.toggle("on"); return edit({ checklist: cardById(S.open).checklist.map((x) => (x.id === d.ckToggle ? { ...x, done: !x.done } : x)) }); }
  if (d.ckDel) return edit({ checklist: cardById(S.open).checklist.filter((x) => x.id !== d.ckDel) });
  if (d.label) { if (cardLocked()) return; const c = cardById(S.open); return edit({ labels: c.labels.includes(d.label) ? c.labels.filter((x) => x !== d.label) : [...c.labels, d.label] }); }
  if (t.id === "upload") return $("file-input").click();
  if (t.id === "link-toggle") { S.linkOpen = !S.linkOpen; renderModal(); return $("link-draft")?.focus(); }
  if (t.id === "add-link") return addLink();
  if (d.cover) { const c = cardById(S.open); loadThumb(d.cover); return edit({ cover: c.cover === d.cover ? "" : d.cover }); }
  if (d.coverRemove !== undefined) return edit({ cover: "" });
  if (d.attDel) { const c = cardById(S.open); const gone = (c.attachments || []).find((a) => a.id === d.attDel); return edit({ attachments: c.attachments.filter((a) => a.id !== d.attDel), ...(gone && c.cover === gone.path ? { cover: "" } : {}) }); }
  if (d.attOpen) {
    const a = (cardById(S.open).attachments || []).find((x) => x.id === d.attOpen); if (!a) return;
    const r = await rpc("attachment", { path: a.path }); if (!r.ok) return toast(r.error);
    const src = `data:${a.mime || "application/octet-stream"};base64,${r.b64}`;
    if (a.kind === "image" || a.kind === "video") { S.lightbox = { kind: a.kind, src, name: a.name }; return renderModal(); }
    const link = document.createElement("a"); link.href = src; link.download = a.name; document.body.appendChild(link); link.click(); link.remove();
    return;
  }
  if (t.id === "post-comment") return postComment();
  if (!S.menu) render();
});

async function submitAdd(colId) {
  const title = ($("new-card")?.value || "").trim(); if (!title) return;
  $("new-card").value = "";
  await act(rpc("create_card", { board: S.boardId, title, column: colId }));
  $("new-card")?.focus();
}
async function postComment() {
  const text = ($("m-comment")?.value || "").trim(); if (!text) return;
  $("m-comment").value = "";
  await act(rpc("comment", { board: S.boardId, card: S.open, text }));
}
async function addLink() {
  let raw = ($("link-draft")?.value || "").trim(); if (!raw) return;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let u; try { u = new URL(raw); } catch { return toast("That doesn't look like a link."); }
  const c = cardById(S.open);
  S.linkOpen = false;
  await edit({ attachments: [...(c.attachments || []), { kind: "link", name: u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? decodeURIComponent(u.pathname) : ""), url: u.href, at: Date.now() / 1000 }] });
}

// Text fields in the card window and the board settings save as they are typed (a pause of
// SAVE_TYPED_MS), so teammates live in the same group see the words arrive; the window keeps
// the field's own text and cursor when the board redraws (renderModal). Leaving the field
// saves what is left.
const SAVE_TYPED_MS = 400;
const TYPED = /^(m-title|m-desc|s-name)$/;
let typedT = 0;
document.addEventListener("input", (e) => {
  if (!TYPED.test(e.target.id || "")) return;
  clearTimeout(typedT);
  const t = e.target;
  typedT = setTimeout(() => saveField(t), SAVE_TYPED_MS);
});

document.addEventListener("change", (e) => {
  if (TYPED.test(e.target.id || "")) clearTimeout(typedT);
  saveField(e.target);
});

function saveField(t) {
  const d = t.dataset;
  if (d.rename) { const c = cols(); const x = c.find((y) => y.id === d.rename); if (t.value.trim() && x.title !== t.value.trim()) { x.title = t.value.trim(); saveColumns(c); } return; }
  if (d.labelName) return saveLabels(board().labels.map((l) => (l.id === d.labelName ? { ...l, name: t.value.trim() || l.name } : l)));
  if (t.id === "s-name") { if (t.value.trim()) act(rpc("update_board", { board: S.boardId, name: t.value.trim() })); return; }
  if (t.id === "file-input") { upload(t.files); t.value = ""; return; }
  if (!S.open) return;
  const c = cardById(S.open); if (!c) return;
  if (t.id === "m-title") { const v = t.value.replace(/\n/g, " ").trim(); if (v && v !== c.title) edit({ title: v }); }
  else if (t.id === "m-desc") { if (t.value !== c.desc) edit({ desc: t.value }); }
  else if (d.ckText) edit({ checklist: c.checklist.map((x) => (x.id === d.ckText ? { ...x, text: t.value } : x)) });
}

document.addEventListener("input", (e) => {
  if (e.target.id === "q") { S.q = e.target.value; render(); }
  if (e.target.id === "m-comment") { e.target.style.height = "auto"; e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`; }
});

document.addEventListener("keydown", (e) => {
  const id = e.target.id;
  if (e.key === "Enter" && !e.shiftKey && id === "new-card") { e.preventDefault(); return submitAdd(S.adding); }
  if (e.key === "Enter" && !e.shiftKey && id === "m-comment") { e.preventDefault(); return postComment(); }
  if (e.key === "Enter" && !e.shiftKey && id === "m-title") { e.preventDefault(); return e.target.blur(); }
  if (e.key === "Enter" && (e.target.dataset?.rename || e.target.dataset?.labelName || id === "s-name")) {
    e.preventDefault();
    return e.target.blur();  // saves it (change)
  }
  if (e.key === "Enter" && id === "m-new-item") {
    const text = e.target.value.trim(); if (!text) return;
    e.target.value = "";
    return edit({ checklist: [...cardById(S.open).checklist, { text, done: false }] }).then(() => $("m-new-item")?.focus());
  }
  if (e.key === "Enter" && id === "link-draft") return addLink();
  if (e.key === "Enter" && id === "new-board-name") return $("create-board").click();
  if ((e.key === "Enter" || e.key === " ") && e.target.dataset && (e.target.dataset.card || e.target.dataset.board) && !e.target.matches("button")) {
    e.preventDefault();
    return e.target.dataset.card ? openCard(e.target.dataset.card) : (S.modal = "", selectBoard(e.target.dataset.board));
  }
  if (e.key !== "Escape") return;
  if (id === "new-card") { S.adding = ""; return render(); }
  if (S.lightbox) { S.lightbox = null; return renderModal(); }
  if (S.menu) { S.menu = ""; return render(); }
  if (id === "link-draft") { S.linkOpen = false; return renderModal(); }
  if (S.modal === "card") return closeCard();
  if (S.modal) { S.modal = ""; render(); }
});

// drag and drop
document.addEventListener("dragstart", (e) => {
  const el = e.target.closest && e.target.closest("[data-card]"); if (!el) return;
  const c = cardById(el.dataset.card), lk = c && lockFor(c);
  if (lk && !lk.mine) { e.preventDefault(); return toast(`Locked: ${lk.who}${lk.task ? " · " + lk.task.toLowerCase() : " is editing"}`); }
  e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("text/plain", c.id); } catch { /* some hosts refuse */ }
  setTimeout(() => { S.drag = c.id; S.menu = ""; render(); }, 0);
});
document.addEventListener("dragend", () => { if (S.drag) { S.drag = ""; S.over = null; render(); } });
document.addEventListener("dragover", (e) => {
  const zone = e.target.closest && e.target.closest("#att-zone");
  if (zone && S.openMine && [...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); zone.classList.add("over"); return; }
  if (!S.drag) return;
  const colEl = e.target.closest && e.target.closest("[data-col]"); if (!colEl) return;
  e.preventDefault();
  const cardEl = e.target.closest("[data-card]");
  let before = null;
  if (cardEl) {
    const r = cardEl.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) before = cardEl.dataset.card;
    else { let nxt = cardEl.nextElementSibling; while (nxt && !nxt.dataset.card) nxt = nxt.nextElementSibling; before = nxt ? nxt.dataset.card : null; }
  }
  const o = S.over;
  if (!o || o.col !== colEl.dataset.col || o.before !== before) { S.over = { col: colEl.dataset.col, before }; render(); }
});
document.addEventListener("dragleave", (e) => { const z = e.target.closest && e.target.closest("#att-zone"); if (z && !z.contains(e.relatedTarget)) z.classList.remove("over"); });
document.addEventListener("drop", async (e) => {
  const zone = e.target.closest && e.target.closest("#att-zone");
  if (zone && e.dataTransfer?.files?.length) { e.preventDefault(); zone.classList.remove("over"); if (S.openMine) upload(e.dataTransfer.files); else cardLocked(); return; }
  if (!S.drag) return;
  e.preventDefault();
  const id = S.drag, o = S.over;
  S.drag = ""; S.over = null;
  if (!o || o.before === id) return render();
  const r = await rpc("move_card", { board: S.boardId, card: id, column: o.col, before: o.before || "" });
  if (!r.ok) toast(r.error);
  await loadView();
});

// host pushes: our own changes, teammates' syncs, visibility
window.addEventListener("message", (ev) => {
  const e = ev.data && ev.data.channel === CHANNEL ? ev.data.event : null;
  if (!e) return;
  if (e.type === "kanban_changed") { if (!S.drag) loadBoardsQuiet(); }
  else if (e.type === "plugin_scope_changed") {
    if (e.reason === "switched") { S.boardId = ""; S.open = ""; S.openMine = false; S.modal = ""; S.known = null; boot(); }
    else loadBoardsQuiet();  // synced: keep the open card, selection and scroll
  } else if (e.type === "panel.visibility") {
    S.visible = !!e.visible;
    if (S.visible) loadPrefs().then(loadBoardsQuiet);
  } else if (e.type === "panel.open_item" && typeof e.item === "string" && e.item) {
    // A board picked from Ducky's @ / / menu or search.
    booted.then(() => { if (S.boardId !== e.item) selectBoard(e.item); });
  }
});
let quiet = 0;
function loadBoardsQuiet() { clearTimeout(quiet); quiet = setTimeout(loadBoards, 120); }
// ponytail: a 4 s poll shows lock expiry and teammates' changes between syncs (the board list
// too: a board renamed elsewhere); push-only once the host sends lock ticks.
setInterval(() => {
  const typing = document.activeElement && document.activeElement.matches("input, textarea");
  if (S.visible && S.boardId && !S.drag && !typing && !document.hidden) loadBoards();
}, POLL_MS);

async function loadPrefs() {
  const r = await rpc("view_prefs");
  if (r.ok) S.prefs = r.prefs;
}
async function boot() {
  try { S.scope = (await call("scope.get")).scope; } catch { S.scope = null; }
  try { const p = await call("prefs.get", { id: "board" }); if (p && typeof p.value === "string") S.boardId = p.value; } catch { /* first run */ }
  try { const p = await call("prefs.get", { id: "seen" }); if (p && p.value && typeof p.value === "object") S.seen = p.value; } catch { /* first run */ }
  await loadPrefs();
  await loadBoards();
  loadPeople();
}
call("plugin.subscribe", { types: ["kanban_changed"] }).catch(() => {});
window.addEventListener("beforeunload", () => { if (S.open && S.openMine) rpc("unlock", { board: S.boardId, card: S.open }); });
const booted = boot();
