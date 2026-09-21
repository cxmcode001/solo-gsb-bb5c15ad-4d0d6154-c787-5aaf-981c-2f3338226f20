"use strict";

const state = {
  plan: null,
  meetings: [],
  currentId: localStorage.getItem("agenda_mtg") ? Number(localStorage.getItem("agenda_mtg")) : null,
};

const $ = (sel) => document.querySelector(sel);

// --------------------------------------------------------------------------- utilities
function toDTInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function hm(iso) { return iso ? iso.slice(11, 16) : ""; }
function fullLabel(iso) { return iso ? iso.slice(5, 16).replace("T", " ") : ""; }

let toastTimer;
function toast(msg, isError) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " toast-error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : "请求失败");
  }
  return data;
}

async function loadMeetings(selectId) {
  state.meetings = await api("GET", "/api/meetings");
  const sel = $("#meetingSelect");
  sel.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择会议…";
  sel.appendChild(placeholder);
  for (const m of state.meetings) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.title}（${fullLabel(m.start_time)}）`;
    sel.appendChild(o);
  }
  if (selectId) sel.value = selectId;
}

async function openMeeting(id) {
  state.currentId = id;
  localStorage.setItem("agenda_mtg", String(id));
  state.plan = await api("GET", `/api/meetings/${id}`);
  $("#setupView").classList.add("hidden");
  $("#meetingView").classList.remove("hidden");
  $("#meetingSelect").value = id;
  renderAll();
}

function showSetup() {
  state.currentId = null;
  localStorage.removeItem("agenda_mtg");
  $("#meetingView").classList.add("hidden");
  $("#setupView").classList.remove("hidden");
  $("#meetingSelect").value = "";
  prefillaMeetingTimes();
}

// --------------------------------------------------------------------------- init defaults
function prefillaMeetingTimes() {
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(now.getMinutes() + (30 - (now.getMinutes() % 30 || 30)));
  const end = new Date(now.getTime() + 90 * 60000);
  $("#mStart").value = toDTInput(now);
  $("#mEnd").value = toDTInput(end);
}

function prefillBreakStart() {
  if (!state.plan) return;
  const start = new Date(state.plan.meeting.start_time);
  start.setMinutes(start.getMinutes() + 30);
  $("#bStart").value = toDTInput(start);
}

// --------------------------------------------------------------------------- render
function renderAll() {
  renderMeetingBar();
  renderConflicts();
  renderItemTable();
  renderBreakTable();
  renderTimeline($("#originalTimeline"), state.plan.original, {
    endLabel: "会议结束",
    endTime: state.plan.meeting.end_time,
  });
  renderTimeline($("#currentTimeline"), state.plan.current, {
    endLabel: "会议结束",
    endTime: state.plan.meeting.end_time,
    anchor: state.plan.live ? state.plan.anchor : null,
  });
  $("#origEnd").textContent = `计划结束 ${fullLabel(state.plan.original.planned_end)}`;
  $("#currEnd").textContent = `预计结束 ${fullLabel(state.plan.current.planned_end)}`;
  setFormsLocked(state.plan.live);
}

function setFormsLocked(live) {
  for (const fid of ["itemForm", "breakForm"]) {
    for (const el of $("#" + fid).elements) el.disabled = live;
  }
  $("#itemHint").textContent = live
    ? "会议进行中：撤销或重置实况后才能修改议程。"
    : "可压缩议程在超时后按优先级从低到高压缩，且不会低于最短时长。";
}

function renderMeetingBar() {
  const p = state.plan;
  $("#mvTitle").textContent = p.meeting.title;
  $("#mvTime").textContent = `会议时间：${fullLabel(p.meeting.start_time)} — ${fullLabel(p.meeting.end_time)}`;
  const badge = $("#liveBadge");
  if (p.live) {
    badge.textContent = `● 实况中 · 锚点 ${hm(p.anchor)}`;
    badge.className = "badge badge-on";
  } else {
    badge.textContent = "未开始录入";
    badge.className = "badge badge-off";
  }
  $("#btnUndo").disabled = p.undo_count === 0;
  $("#btnUndo").textContent = p.undo_count ? `↩ 撤销上一步 (${p.undo_count})` : "↩ 撤销上一步";
  $("#btnReset").disabled = !p.live;
}

function renderConflicts() {
  const p = state.plan;
  const panel = $("#conflictPanel");
  const all = [
    ...p.original.conflicts.map((c) => ({ ...c, kind: c.type, scope: "原计划" })),
    ...p.current.conflicts.map((c) => ({ ...c, kind: c.type, scope: "新计划" })),
  ];
  if (!all.length) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  panel.innerHTML = all.map((c) => {
    const warn = c.kind === "anchor_overlap";
    const badge = c.overflow_minutes > 0
      ? `<span class="over-badge">超出 ${c.overflow_minutes} 分钟</span>` : "";
    return `<div class="conflict-card ${warn ? "warn-kind" : ""}">
      <h4>⚠ ${c.scope}：${c.title}${badge}</h4>
      <p>${c.message}</p>
    </div>`;
  }).join("");

  // postponement suggestion entry: only when real overtime exists
  if (all.some((c) => (c.overflow_minutes || 0) > 0)) {
    const bar = document.createElement("div");
    bar.className = "conflict-actions";
    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "🗓 生成延期建议";
    btn.addEventListener("click", openPostponeSuggestion);
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = "将未完成且可延期的低优先级议程移出本次会议以消除冲突（先预览试排，确认后才保存，可撤销）";
    bar.appendChild(btn);
    bar.appendChild(hint);
    panel.appendChild(bar);
  }
}

function priorityPill(pri) {
  return `<span class="pill pill-p${pri}">P${pri}</span>`;
}

function renderItemTable() {
  const p = state.plan;
  const tbody = $("#itemTable tbody");
  $("#itemCount").textContent = p.items.length ? `${p.items.length} 项` : "";
  if (!p.items.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted" style="text-align:center;padding:18px">尚未添加议程项</td></tr>`;
    return;
  }
  const ordered = [...p.items].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const firstPending = ordered.find((it) => !it.actual_end && !it.postponed);
  tbody.innerHTML = ordered.map((it, i) => {
    const attrs = (it.incompressible
      ? `<span class="tag-lock">🔒 不可压缩</span>` : `<span class="muted">可压缩</span>`)
      + (it.postponed ? `<span class="tag-postpone">📤 已延期</span>` : "");
    let actions;
    if (it.postponed) {
      actions = `<span class="muted">已移出会议</span>`;
    } else if (it.actual_end) {
      actions = `<span class="muted">已完成</span>`;
    } else {
      const canRecord = it.id === firstPending?.id;
      actions = `
        <button class="mini-btn record-btn" data-act="record" data-id="${it.id}"
          data-title="${escapeHtml(it.title)}" ${canRecord ? "" : "disabled"}
          title="${canRecord ? "录入实际结束时间并重排" : "需先完成前面的议程"}">⏱ 实况</button>
        <button class="mini-btn" data-act="up" data-id="${it.id}" ${i === 0 || p.live ? "disabled" : ""}>↑</button>
        <button class="mini-btn" data-act="down" data-id="${it.id}" ${i === ordered.length - 1 || p.live ? "disabled" : ""}>↓</button>
        <button class="btn-danger-mini" data-act="del" data-id="${it.id}" ${p.live ? "disabled" : ""}>删除</button>`;
    }
    return `<tr>
      <td>${i + 1}</td>
      <td><strong>${escapeHtml(it.title)}</strong>${attrs}</td>
      <td>${it.planned_minutes}′</td>
      <td>${it.minimum_minutes}′</td>
      <td>${priorityPill(it.priority)}</td>
      <td>${it.incompressible ? "保持计划时长" : "可压缩至最短"}</td>
      <td>${it.actual_end ? `<span class="actual-val">${hm(it.actual_end)}</span>` : "—"}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("");
}

function renderBreakTable() {
  const p = state.plan;
  const tbody = $("#breakTable tbody");
  $("#breakCount").textContent = p.breaks.length ? `${p.breaks.length} 段` : "";
  if (!p.breaks.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:18px">尚未添加固定休息段</td></tr>`;
    return;
  }
  const order = [...p.breaks].sort((a, b) => a.fixed_start.localeCompare(b.fixed_start));
  tbody.innerHTML = order.map((b) => `<tr>
    <td><strong>${escapeHtml(b.title)}</strong></td>
    <td>${fullLabel(b.fixed_start)}</td>
    <td>${b.duration_minutes}′</td>
    <td>${p.live ? `<span class="muted">会议中</span>`
      : `<button class="btn-danger-mini" data-act="del-break" data-id="${b.id}">删除</button>`}</td>
  </tr>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --------------------------------------------------------------------------- timeline
function chooseTickStep(spanMin) {
  if (spanMin <= 120) return 15;
  if (spanMin <= 300) return 30;
  return 60;
}

function renderTimeline(container, plan, opts = {}) {
  container.innerHTML = "";
  const vStart = new Date(plan.view_start);
  const vEnd = new Date(plan.view_end);
  const spanMin = Math.max(1, Math.round((vEnd - vStart) / 60000));
  const step = chooseTickStep(spanMin);

  const pct = (iso) => {
    const d = new Date(iso);
    return Math.max(0, Math.min(100, ((d - vStart) / 60000 / spanMin) * 100));
  };

  // ruler
  const ruler = document.createElement("div");
  ruler.className = "tl-ruler";
  const tickDate = new Date(vStart);
  tickDate.setSeconds(0, 0);
  tickDate.setMinutes(Math.ceil(tickDate.getMinutes() / step) * step);
  while (tickDate <= vEnd) {
    const t = document.createElement("span");
    t.className = "tl-tick";
    t.style.left = pct(toDTInput(tickDate)) + "%";
    t.textContent = hm(toDTInput(tickDate));
    ruler.appendChild(t);
    tickDate.setMinutes(tickDate.getMinutes() + step);
  }
  container.appendChild(ruler);

  // lanes
  const itemLane = document.createElement("div");
  itemLane.className = "tl-lane";
  itemLane.appendChild(laneLabel("议程"));
  const breakLane = document.createElement("div");
  breakLane.className = "tl-lane";
  breakLane.appendChild(laneLabel("固定休息"));

  let any = false;
  for (const seg of plan.segments) {
    const bar = document.createElement("div");
    const width = Math.max((seg.duration / spanMin) * 100, seg.duration ? 0.8 : 0);
    bar.className = "tl-bar " + barClass(seg);
    bar.style.left = pct(seg.start) + "%";
    bar.style.width = width + "%";
    const delta = seg.kind === "item" ? seg.duration - seg.planned_duration : 0;
    const deltaTxt = delta < 0 ? `（压缩 ${-delta}′）` : "";
    bar.title = `${seg.title}\n${seg.start_time}–${seg.end_time} · ${seg.duration}分钟${deltaTxt}`;
    bar.textContent = `${seg.title} ${seg.duration}′${deltaTxt ? " " + deltaTxt : ""}`;
    (seg.kind === "break" ? breakLane : itemLane).appendChild(bar);
    any = true;
  }

  if (!any) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.cssText = "padding:14px 0 4px 86px;font-size:.82rem";
    empty.textContent = "暂无内容 — 请先在左侧添加议程项或休息段";
    container.appendChild(empty);
  }
  container.appendChild(itemLane);
  container.appendChild(breakLane);

  // anchor (now) marker
  if (opts.anchor) {
    const mark = document.createElement("div");
    mark.className = "tl-now";
    mark.style.left = `calc(86px + (100% - 236px) * ${pct(opts.anchor)} / 100)`;
    mark.innerHTML = `<span>当前 ${hm(opts.anchor)}</span>`;
    container.appendChild(mark);
  }

  // meeting end marker
  if (opts.endTime) {
    const pos = pct(opts.endTime);
    if (pos < 100) {
      const mark = document.createElement("div");
      mark.className = "tl-end-mark";
      mark.style.left = `calc(86px + (100% - 236px) * ${pos} / 100)`;
      mark.innerHTML = `<span>${opts.endLabel} ${hm(opts.endTime)}</span>`;
      container.appendChild(mark);
    }
  }
}

function laneLabel(text) {
  const l = document.createElement("span");
  l.className = "tl-lane-label";
  l.textContent = text;
  return l;
}

function barClass(seg) {
  if (seg.kind === "break") {
    if (seg.status === "completed") return "bar-completed-break";
    if (seg.status === "anchor_overlap") return "bar-anchor-break";
    return "bar-break";
  }
  return "bar-" + seg.status;
}

// --------------------------------------------------------------------------- events
$("#meetingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const m = await api("POST", "/api/meetings", {
      title: $("#mTitle").value.trim() || "未命名会议",
      start_time: $("#mStart").value,
      end_time: $("#mEnd").value,
    });
    await loadMeetings(m.id);
    await openMeeting(m.id);
    prefillBreakStart();
    toast("会议已创建");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btnNewMeeting").addEventListener("click", showSetup);

$("#meetingSelect").addEventListener("change", async (e) => {
  if (e.target.value) await openMeeting(Number(e.target.value));
  else showSetup();
});

$("#itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const planned = Number($("#iPlanned").value);
    const minimum = Number($("#iMin").value);
    if (minimum > planned) throw new Error("最短时长不能大于计划时长");
    const incomp = $("#iIncompressible").checked;
    if (incomp) $("#iMin").value = planned;
    await api("POST", `/api/meetings/${state.currentId}/items`, {
      title: $("#iTitle").value.trim(),
      planned_minutes: planned,
      minimum_minutes: incomp ? planned : minimum,
      priority: Number($("#iPriority").value),
      incompressible: incomp,
    });
    $("#iTitle").value = "";
    state.plan = await api("GET", `/api/meetings/${state.currentId}`);
    renderAll();
    toast("议程项已添加");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#iIncompressible").addEventListener("change", (e) => {
  if (e.target.checked) {
    $("#iMin").value = $("#iPlanned").value;
    $("#iMin").disabled = true;
  } else {
    $("#iMin").disabled = false;
  }
});

$("#breakForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("POST", `/api/meetings/${state.currentId}/breaks`, {
      title: $("#bTitle").value.trim() || "休息",
      fixed_start: $("#bStart").value,
      duration_minutes: Number($("#bDuration").value),
    });
    $("#bTitle").value = "";
    state.plan = await api("GET", `/api/meetings/${state.currentId}`);
    renderAll();
    toast("固定休息段已添加");
  } catch (err) {
    toast(err.message, true);
  }
});

// delegated table actions
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = Number(btn.dataset.id);
  try {
    if (act === "del") {
      if (!confirm("确定删除该议程项？")) return;
      await api("DELETE", `/api/items/${id}`);
      await refresh();
    } else if (act === "del-break") {
      await api("DELETE", `/api/breaks/${id}`);
      await refresh();
    } else if (act === "up" || act === "down") {
      await api("POST", `/api/items/${id}/move`, { direction: act });
      await refresh();
    } else if (act === "record") {
      openActualModal(id, btn.dataset.title);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

async function refresh() {
  state.plan = await api("GET", `/api/meetings/${state.currentId}`);
  renderAll();
}

// actual modal
function openActualModal(itemId, title) {
  $("#actualItemId").value = itemId;
  $("#modalItemTitle").textContent = `议程：${title}`;
  const now = new Date();
  $("#actualEnd").value = toDTInput(now);
  $("#actualModal").classList.remove("hidden");
}

$("#cancelActual").addEventListener("click", () => $("#actualModal").classList.add("hidden"));
$("#actualModal").addEventListener("click", (e) => {
  if (e.target.id === "actualModal") $("#actualModal").classList.add("hidden");
});

$("#actualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    state.plan = await api("POST", `/api/meetings/${state.currentId}/actuals`, {
      item_id: Number($("#actualItemId").value),
      actual_end: $("#actualEnd").value,
    });
    $("#actualModal").classList.add("hidden");
    renderAll();
    const n = state.plan.current.conflicts.length;
    toast(n ? `已重排：发现 ${n} 项冲突，请查看红色提示` : "已重排，所有议程均可容纳");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btnUndo").addEventListener("click", async () => {
  try {
    state.plan = await api("POST", `/api/meetings/${state.currentId}/undo`);
    renderAll();
    toast("已撤销最近一步操作");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btnReset").addEventListener("click", async () => {
  if (!confirm("确定清除所有实际结束时间？（之后可用撤销恢复）")) return;
  try {
    state.plan = await api("POST", `/api/meetings/${state.currentId}/reset`);
    renderAll();
    toast("已重置实况");
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------------------
// postponement suggestion modal
// ---------------------------------------------------------------------------
let currentSuggestion = null;

async function openPostponeSuggestion() {
  try {
    const s = await api("POST", `/api/meetings/${state.currentId}/postpone-suggestion`);
    currentSuggestion = s;
    renderPostponeModal(s);
    $("#postponeModal").classList.remove("hidden");
  } catch (err) {
    toast(err.message, true);
  }
}

function renderPostponeModal(s) {
  const summary = $("#postponeSummary");
  const list = $("#postponeList");
  const confirmBtn = $("#confirmPostpone");

  if (!s.postponed.length) {
    summary.innerHTML = `<div class="ok-banner">✅ 当前议程均可容纳，无需延期。</div>`;
    list.innerHTML = "";
    confirmBtn.disabled = true;
  } else {
    const rows = s.postponed.map((p, i) => `<tr>
      <td>${i + 1}</td>
      <td><strong>${escapeHtml(p.title)}</strong></td>
      <td>${priorityPill(p.priority)}</td>
      <td>${p.planned_minutes}′</td>
    </tr>`).join("");
    list.innerHTML = `<table class="data-table">
      <thead><tr><th>#</th><th>将延期的议程（移出本次会议）</th><th>优先级</th><th>释放计划时长</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    if (s.feasible) {
      summary.innerHTML = `<div class="ok-banner">✅ 将以下 ${s.postponed.length} 项移出本次会议
        （共释放 ${s.freed_minutes} 分钟），重排后冲突全部消除。确认后保存，且可撤销。</div>`;
      confirmBtn.disabled = false;
    } else {
      summary.innerHTML = `<div class="danger-banner">⚠ 即使将以下 ${s.postponed.length} 项全部延期
        （共释放 ${s.freed_minutes} 分钟），仍超出 ${s.remaining_overflow_minutes} 分钟。
        无法确认延期 — 请延长会议时间或调整议程。</div>`;
      confirmBtn.disabled = true;
    }
  }

  renderTimeline($("#postponeTimeline"), s.timeline, {
    endLabel: "会议结束",
    endTime: state.plan.meeting.end_time,
    anchor: state.plan.live ? s.timeline.anchor : null,
  });
}

function closePostponeModal() {
  $("#postponeModal").classList.add("hidden");
  currentSuggestion = null;
}

$("#cancelPostpone").addEventListener("click", closePostponeModal);
$("#postponeModal").addEventListener("click", (e) => {
  if (e.target.id === "postponeModal") closePostponeModal();
});

$("#confirmPostpone").addEventListener("click", async () => {
  if (!currentSuggestion || !currentSuggestion.postponed.length) return;
  try {
    const ids = currentSuggestion.postponed.map((p) => p.id);
    state.plan = await api("POST", `/api/meetings/${state.currentId}/postpone`, { item_ids: ids });
    closePostponeModal();
    renderAll();
    toast(`已延期 ${ids.length} 项议程并立即重排（可撤销）`);
  } catch (err) {
    toast(err.message, true);
  }
});

// --------------------------------------------------------------------------- boot
(async function boot() {
  prefillaMeetingTimes();
  try {
    await loadMeetings(state.currentId);
    if (state.currentId && state.meetings.some((m) => m.id === state.currentId)) {
      await openMeeting(state.currentId);
      prefillBreakStart();
    } else {
      showSetup();
    }
  } catch (err) {
    toast("初始化失败：" + err.message, true);
  }
})();
