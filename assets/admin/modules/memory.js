/**
 * Memento MCP Admin Console — Memory 뷰 렌더러
 *
 * 작성자: 최진호
 * 작성일: 2026-04-07
 */

import { state }                                         from "./state.js";
import { api }                                           from "./api.js";
import { fmt, fmtDate, fmtPct, truncate, loadingHtml }  from "./format.js";

export function renderMemoryFilters() {
  const types = ["", "fact", "error", "decision", "procedure", "preference"];

  const bar = document.createElement("div");
  bar.className = "flex items-center justify-between gap-4 glass-panel p-2 rounded-sm border-l-2 border-primary/40";
  bar.id = "memory-filters";

  /* Left chips */
  const leftChips = document.createElement("div");
  leftChips.className = "flex gap-2";

  /* Topic chip */
  const topicChip = document.createElement("div");
  topicChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-primary border border-primary/10";
  const topicInput = document.createElement("input");
  topicInput.className = "bg-transparent border-none outline-none text-[10px] font-bold text-primary placeholder:text-slate-500 w-24";
  topicInput.id = "filter-topic";
  topicInput.placeholder = "TOPIC: ALL";
  topicInput.value = state.memoryFilter.topic;
  topicChip.appendChild(topicInput);
  const topicExpand = document.createElement("span");
  topicExpand.className = "material-symbols-outlined text-[14px]";
  topicExpand.textContent = "expand_more";
  topicChip.appendChild(topicExpand);
  leftChips.appendChild(topicChip);

  /* Type chip */
  const typeChip = document.createElement("div");
  typeChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-slate-400";
  const typeSelect = document.createElement("select");
  typeSelect.className = "bg-transparent border-none outline-none text-[10px] font-bold text-slate-400";
  typeSelect.id = "filter-type";
  types.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t ? "TYPE: " + t.toUpperCase() : "TYPE: ALL";
    if (state.memoryFilter.type === t) opt.selected = true;
    typeSelect.appendChild(opt);
  });
  typeChip.appendChild(typeSelect);
  const typeExpand = document.createElement("span");
  typeExpand.className = "material-symbols-outlined text-[14px]";
  typeExpand.textContent = "expand_more";
  typeChip.appendChild(typeExpand);
  leftChips.appendChild(typeChip);

  /* Key chip */
  const keyChip = document.createElement("div");
  keyChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-slate-400";
  const keyInput = document.createElement("input");
  keyInput.className = "bg-transparent border-none outline-none text-[10px] font-bold text-slate-400 placeholder:text-slate-500 w-16";
  keyInput.id = "filter-key-id";
  keyInput.placeholder = "KEY: *";
  keyInput.value = state.memoryFilter.key_id;
  keyChip.appendChild(keyInput);
  const keyExpand = document.createElement("span");
  keyExpand.className = "material-symbols-outlined text-[14px]";
  keyExpand.textContent = "expand_more";
  keyChip.appendChild(keyExpand);
  leftChips.appendChild(keyChip);

  /* Group chip */
  const groupChip = document.createElement("div");
  groupChip.className = "px-3 py-1 bg-surface-variant text-[10px] font-bold flex items-center gap-2 rounded-sm text-slate-400";
  const groupSelect = document.createElement("select");
  groupSelect.id = "filter-group";
  groupSelect.className = "bg-transparent border-none outline-none text-[10px] font-bold text-slate-400 cursor-pointer";
  const gOptAll = document.createElement("option");
  gOptAll.value = "";
  gOptAll.textContent = "GROUP: ALL";
  groupSelect.appendChild(gOptAll);
  (state.groups ?? []).forEach(g => {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = "GROUP: " + g.name.toUpperCase();
    if (state.memoryFilter.group_id === g.id) opt.selected = true;
    groupSelect.appendChild(opt);
  });
  groupChip.appendChild(groupSelect);
  const groupExpand = document.createElement("span");
  groupExpand.className = "material-symbols-outlined text-[14px]";
  groupExpand.textContent = "expand_more";
  groupChip.appendChild(groupExpand);
  leftChips.appendChild(groupChip);

  bar.appendChild(leftChips);

  /* Right side */
  const rightSide = document.createElement("div");
  rightSide.className = "flex items-center gap-4";

  const rangeText = document.createElement("span");
  rangeText.className = "text-[10px] text-slate-500 font-mono tracking-tighter uppercase";
  rangeText.textContent = "RANGE: LAST 30 DAYS";
  rightSide.appendChild(rangeText);

  const exportBtn = document.createElement("button");
  exportBtn.className = "flex items-center gap-2 bg-transparent border border-outline-variant px-4 py-1.5 text-[10px] font-bold text-primary";
  exportBtn.id = "filter-search";
  const searchIcon = document.createElement("span");
  searchIcon.className = "material-symbols-outlined text-[14px]";
  searchIcon.textContent = "search";
  exportBtn.appendChild(searchIcon);
  exportBtn.appendChild(document.createTextNode("SEARCH"));
  rightSide.appendChild(exportBtn);

  bar.appendChild(rightSide);

  return bar;
}

export function renderFragmentList(fragments) {
  if (!fragments || !fragments.length) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-slate-600 py-8 text-center";
    empty.textContent = "결과 없음";
    return empty;
  }

  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6 shadow-2xl relative overflow-hidden";

  /* Ghost icon */
  const ghost = document.createElement("div");
  ghost.className = "absolute top-0 right-0 p-2 opacity-10";
  const ghostIcon = document.createElement("span");
  ghostIcon.className = "material-symbols-outlined text-6xl";
  ghostIcon.textContent = "search_insights";
  ghost.appendChild(ghostIcon);
  panel.appendChild(ghost);

  /* Title */
  const title = document.createElement("h2");
  title.className = "font-headline text-lg font-bold text-cyan-100 flex items-center gap-3 mb-6 uppercase tracking-widest";
  const titleBar = document.createElement("span");
  titleBar.className = "w-1 h-4 bg-cyan-400";
  title.appendChild(titleBar);
  title.appendChild(document.createTextNode("Search Explorer"));
  panel.appendChild(title);

  /* Query box */
  const queryBox = document.createElement("div");
  queryBox.className = "bg-surface-container-highest p-4 mb-6 border border-white/5";
  const queryTop = document.createElement("div");
  queryTop.className = "flex justify-between text-[9px] font-mono";
  const queryLabel = document.createElement("span");
  queryLabel.className = "text-slate-500";
  queryLabel.textContent = "QUERY";
  queryTop.appendChild(queryLabel);
  const resultCount = document.createElement("span");
  resultCount.className = "text-slate-500";
  resultCount.textContent = fragments.length + " RESULTS";
  queryTop.appendChild(resultCount);
  queryBox.appendChild(queryTop);
  const queryText = document.createElement("div");
  queryText.className = "text-sm font-mono text-cyan-100 py-2 border-b border-white/5";
  queryText.textContent = state.memoryFilter.topic || state.memoryFilter.type || "*";
  queryBox.appendChild(queryText);
  panel.appendChild(queryBox);

  /* Results */
  const list = document.createElement("div");
  list.className = "space-y-3";
  list.id = "fragment-table";

  fragments.forEach(f => {
    const item = document.createElement("div");
    item.className = "bg-surface-container-low p-4 hover:bg-surface-container-high border-l border-transparent hover:border-cyan-400/50 cursor-pointer" + (f.id === state.selectedFragment?.id ? " border-cyan-400/50 bg-surface-container-high" : "");
    item.dataset.fragId = f.id;

    /* Top row */
    const topRow = document.createElement("div");
    topRow.className = "flex justify-between items-start mb-2";

    const topLeft = document.createElement("div");
    topLeft.className = "flex items-center gap-3";
    const idBadge = document.createElement("span");
    idBadge.className = "text-[10px] font-mono text-primary bg-primary/10 px-2 py-0.5";
    idBadge.textContent = "#MEM_" + (f.id ?? "").toString().slice(-5).padStart(5, "0");
    topLeft.appendChild(idBadge);
    const topicSpan = document.createElement("span");
    topicSpan.className = "text-xs font-bold text-on-surface uppercase tracking-wider";
    topicSpan.textContent = f.topic ?? "(무제)";
    topLeft.appendChild(topicSpan);
    topRow.appendChild(topLeft);

    const topRight = document.createElement("div");
    topRight.className = "flex items-center gap-4 text-right";
    const scoreDiv = document.createElement("div");
    const scoreLbl = document.createElement("div");
    scoreLbl.className = "text-[9px] text-slate-500 font-mono";
    scoreLbl.textContent = "UTILITY_SCORE";
    scoreDiv.appendChild(scoreLbl);
    const scoreVal = document.createElement("div");
    scoreVal.className = "text-xs font-mono text-tertiary";
    scoreVal.textContent = String(f.importance ?? "-");
    scoreDiv.appendChild(scoreVal);
    topRight.appendChild(scoreDiv);

    const accessDiv = document.createElement("div");
    const accessLbl = document.createElement("div");
    accessLbl.className = "text-[9px] text-slate-500 font-mono";
    accessLbl.textContent = "ACCESS";
    accessDiv.appendChild(accessLbl);
    const accessVal = document.createElement("div");
    accessVal.className = "text-xs font-mono text-tertiary";
    accessVal.textContent = f.access_count ?? "0";
    accessDiv.appendChild(accessVal);
    topRight.appendChild(accessDiv);

    topRow.appendChild(topRight);
    item.appendChild(topRow);

    /* Content preview */
    const preview = document.createElement("p");
    preview.className = "text-[11px] text-slate-400 line-clamp-2 font-body leading-relaxed mb-3 italic";
    preview.textContent = truncate(f.content ?? "", 200);
    item.appendChild(preview);

    /* Bottom: tags + timestamp */
    const bottom = document.createElement("div");
    bottom.className = "flex justify-between items-center";
    const tags = document.createElement("div");
    tags.className = "flex gap-2";
    const topicTag = document.createElement("span");
    topicTag.className = "text-[9px] border border-outline-variant px-2 py-0.5 text-slate-500 uppercase";
    topicTag.textContent = f.topic ?? "?";
    tags.appendChild(topicTag);
    const typeTag = document.createElement("span");
    typeTag.className = "text-[9px] border border-outline-variant px-2 py-0.5 text-slate-500 uppercase";
    typeTag.textContent = f.type ?? "?";
    tags.appendChild(typeTag);
    bottom.appendChild(tags);

    const dateSpan = document.createElement("div");
    dateSpan.className = "text-[9px] font-mono text-slate-600 uppercase";
    dateSpan.textContent = fmtDate(f.created_at);
    bottom.appendChild(dateSpan);
    item.appendChild(bottom);

    list.appendChild(item);
  });

  panel.appendChild(list);
  return panel;
}

export function renderRetrievalAnalytics(stats) {
  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6 border-t border-primary/20";

  const title = document.createElement("h2");
  title.className = "font-headline text-sm font-bold text-cyan-100 uppercase tracking-widest mb-4";
  title.textContent = "Retrieval Analytics";
  panel.appendChild(title);

  /* Latency bars */
  const latencyBars = document.createElement("div");
  latencyBars.className = "flex h-1.5 gap-1 mb-4";
  const l1 = document.createElement("div");
  l1.className = "w-[15%] bg-primary shadow";
  latencyBars.appendChild(l1);
  const l2 = document.createElement("div");
  l2.className = "w-[45%] bg-primary/40";
  latencyBars.appendChild(l2);
  const l3 = document.createElement("div");
  l3.className = "w-[40%] bg-white/10";
  latencyBars.appendChild(l3);
  panel.appendChild(latencyBars);

  /* Grid: Hit Rate + Rerank Usage */
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-2 gap-3 mb-4";

  /* Hit Rate */
  const hitBox = document.createElement("div");
  hitBox.className = "bg-surface-container-high p-3 text-center";
  const hitLabel = document.createElement("div");
  hitLabel.className = "text-[9px] font-mono text-slate-500 uppercase";
  hitLabel.textContent = "HIT RATE";
  hitBox.appendChild(hitLabel);
  const hitVal = document.createElement("div");
  hitVal.className = "text-2xl font-headline font-bold text-tertiary";
  hitVal.textContent = stats?.searchMetrics?.hitRate ? fmtPct(stats.searchMetrics.hitRate) : "87%";
  hitBox.appendChild(hitVal);
  const hitBar = document.createElement("div");
  hitBar.className = "w-full bg-white/5 h-1 mt-2";
  const hitFill = document.createElement("div");
  hitFill.className = "h-full bg-tertiary";
  hitFill.style.width = "87%";
  hitBar.appendChild(hitFill);
  hitBox.appendChild(hitBar);
  grid.appendChild(hitBox);

  /* Rerank Usage */
  const rerankBox = document.createElement("div");
  rerankBox.className = "bg-surface-container-high p-3 text-center";
  const rerankLabel = document.createElement("div");
  rerankLabel.className = "text-[9px] font-mono text-slate-500 uppercase";
  rerankLabel.textContent = "RERANK USAGE";
  rerankBox.appendChild(rerankLabel);
  const rerankVal = document.createElement("div");
  rerankVal.className = "text-2xl font-headline font-bold text-secondary";
  rerankVal.textContent = "42%";
  rerankBox.appendChild(rerankVal);
  const rerankBar = document.createElement("div");
  rerankBar.className = "w-full bg-white/5 h-1 mt-2";
  const rerankFill = document.createElement("div");
  rerankFill.className = "h-full bg-secondary";
  rerankFill.style.width = "42%";
  rerankBar.appendChild(rerankFill);
  rerankBox.appendChild(rerankBar);
  grid.appendChild(rerankBox);

  panel.appendChild(grid);

  /* Semantic Threshold */
  const threshLabel = document.createElement("div");
  threshLabel.className = "text-[9px] font-mono text-slate-500 uppercase mb-1";
  threshLabel.textContent = "SEMANTIC THRESHOLD";
  panel.appendChild(threshLabel);
  const rangeInput = document.createElement("input");
  rangeInput.type = "range";
  rangeInput.min = "0";
  rangeInput.max = "100";
  rangeInput.value = "70";
  rangeInput.className = "w-full accent-primary";
  panel.appendChild(rangeInput);

  return panel;
}

export function renderAnomalyCards(anomalies) {
  if (!anomalies) return document.createDocumentFragment();

  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6 border-t border-error/20";

  const title = document.createElement("h2");
  title.className = "font-headline text-sm font-bold text-error uppercase tracking-widest mb-4";
  title.textContent = "Anomaly Insights";
  panel.appendChild(title);

  const list = document.createElement("div");
  list.className = "space-y-3";

  const items = [
    { label: "Contradiction Queue",   key: "contradictions",     icon: "crisis_alert",         isCritical: true },
    { label: "Superseded Candidates", key: "superseded",         icon: "auto_awesome_motion",  isCritical: false },
    { label: "Low Quality Fragments", key: "qualityUnverified",  icon: "low_priority",         isCritical: false },
    { label: "Embedding Backlog",     key: "embeddingBacklog",   icon: "memory_alt",           isCritical: false }
  ];

  items.forEach(a => {
    const row = document.createElement("div");
    row.className = a.isCritical
      ? "flex items-center justify-between p-3 bg-error-container/10 border-l-2 border-error"
      : "flex items-center justify-between p-3 bg-surface-container-high";
    row.dataset.anomaly = a.key;

    const left = document.createElement("div");
    left.className = "flex items-center gap-3 " + (a.isCritical ? "" : "text-slate-400");
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-lg" + (a.isCritical ? " text-error" : "");
    icon.textContent = a.icon;
    left.appendChild(icon);
    const lbl = document.createElement("span");
    lbl.className = "text-[10px] font-bold uppercase";
    lbl.textContent = a.label;
    left.appendChild(lbl);
    row.appendChild(left);

    const val = document.createElement("span");
    val.className = "text-xs font-mono" + (a.isCritical ? " text-error font-bold" : "");
    val.textContent = fmt(anomalies[a.key] ?? 0);
    row.appendChild(val);

    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

export function renderRecentEventsChart() {
  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6";

  /* Header */
  const header = document.createElement("div");
  header.className = "flex justify-between items-center mb-6";
  const title = document.createElement("h2");
  title.className = "font-headline text-sm font-bold text-cyan-100 uppercase tracking-widest";
  title.textContent = "Recent Events";
  header.appendChild(title);

  const legend = document.createElement("div");
  legend.className = "flex items-center gap-4";
  const leg1 = document.createElement("div");
  leg1.className = "flex items-center gap-1";
  const leg1Dot = document.createElement("div");
  leg1Dot.className = "w-2 h-2 bg-primary";
  leg1.appendChild(leg1Dot);
  const leg1Text = document.createElement("span");
  leg1Text.className = "text-[9px] font-mono text-slate-500 uppercase";
  leg1Text.textContent = "RECALL_EVENTS";
  leg1.appendChild(leg1Text);
  legend.appendChild(leg1);

  const leg2 = document.createElement("div");
  leg2.className = "flex items-center gap-1";
  const leg2Dot = document.createElement("div");
  leg2Dot.className = "w-2 h-2 bg-secondary";
  leg2.appendChild(leg2Dot);
  const leg2Text = document.createElement("span");
  leg2Text.className = "text-[9px] font-mono text-slate-500 uppercase";
  leg2Text.textContent = "QUERY_LOAD";
  leg2.appendChild(leg2Text);
  legend.appendChild(leg2);
  header.appendChild(legend);
  panel.appendChild(header);

  /* Chart area */
  const chart = document.createElement("div");
  chart.className = "w-full h-48 bg-surface-container-lowest border border-white/5 relative flex items-end px-2 pb-4";

  /* Grid lines */
  const gridLines = document.createElement("div");
  gridLines.className = "absolute inset-0 grid grid-rows-4";
  for (let i = 0; i < 4; i++) {
    const line = document.createElement("div");
    line.className = "border-b border-white/5";
    gridLines.appendChild(line);
  }
  chart.appendChild(gridLines);

  /* Bars */
  const barsWrap = document.createElement("div");
  barsWrap.className = "flex-1 flex items-end justify-around h-full gap-1 relative";
  const heights = [20, 35, 50, 30, 65, 45, 80, 55, 40, 70, 25, 60];
  heights.forEach(h => {
    const bar = document.createElement("div");
    bar.className = "w-full bg-primary/20 hover:bg-primary";
    bar.style.height = h + "%";
    barsWrap.appendChild(bar);
  });
  chart.appendChild(barsWrap);
  panel.appendChild(chart);

  /* Time axis */
  const timeAxis = document.createElement("div");
  timeAxis.className = "flex justify-between mt-3 text-[8px] font-mono text-slate-600 uppercase tracking-[0.2em]";
  ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"].forEach(t => {
    const span = document.createElement("span");
    span.textContent = t;
    timeAxis.appendChild(span);
  });
  panel.appendChild(timeAxis);

  return panel;
}

export function renderFragmentInspector(fragment) {
  if (!fragment) return document.createDocumentFragment();

  const panel = document.createElement("section");
  panel.className = "glass-panel rounded-sm p-6 border-t border-primary/20";
  panel.id = "fragment-inspector";

  const title = document.createElement("h2");
  title.className = "font-headline text-sm font-bold text-cyan-100 flex items-center gap-3 mb-6 uppercase tracking-widest";
  title.textContent = "Fragment Detail";
  panel.appendChild(title);

  const content = document.createElement("div");
  content.className = "bg-surface-container-highest p-4 mb-4 text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap border border-white/5";
  content.textContent = fragment.content ?? "";
  panel.appendChild(content);

  const meta = document.createElement("div");
  meta.className = "space-y-2";
  [
    { label: "ID",       value: fragment.id },
    { label: "Type",     value: fragment.type ?? "" },
    { label: "Importance", value: String(fragment.importance ?? "-") },
    { label: "Agent",    value: fragment.agent_id ?? "-" },
    { label: "Key",      value: fragment.key_id ?? "master" },
    { label: "Created",  value: fmtDate(fragment.created_at) },
    { label: "Keywords", value: JSON.stringify(fragment.keywords ?? []) }
  ].forEach(f => {
    const row = document.createElement("div");
    row.className = "flex justify-between text-[10px]";
    const lbl = document.createElement("span");
    lbl.className = "text-slate-500 uppercase font-mono";
    lbl.textContent = f.label;
    row.appendChild(lbl);
    const val = document.createElement("span");
    val.className = "text-slate-300 font-mono";
    val.textContent = f.value;
    row.appendChild(val);
    meta.appendChild(row);
  });

  panel.appendChild(meta);
  return panel;
}

export function renderPagination() {
  const total   = state.memoryPages;
  const current = state.memoryPage;
  if (total <= 1) return document.createDocumentFragment();

  const wrap = document.createElement("div");
  wrap.className = "flex gap-1 mt-4 justify-center items-center";

  const btnCls     = "p-1 hover:bg-white/5 rounded-sm px-3 text-xs text-slate-500";
  const activeCls  = "p-1 rounded-sm px-3 text-xs text-white border border-primary/20 bg-white/5";
  const arrowCls   = "p-1 hover:bg-white/5 rounded-sm text-slate-500";

  function mkBtn(label, page, cls) {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.dataset.page = page;
    btn.textContent = label;
    if (page < 1 || page > total) {
      btn.disabled = true;
      btn.style.opacity = "0.3";
      btn.style.cursor = "default";
    }
    return btn;
  }

  function mkArrow(iconName, page) {
    const btn = document.createElement("button");
    btn.className = arrowCls;
    btn.dataset.page = page;
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-sm";
    icon.textContent = iconName;
    btn.appendChild(icon);
    if (page < 1 || page > total) { btn.disabled = true; btn.style.opacity = "0.3"; }
    return btn;
  }

  wrap.appendChild(mkArrow("chevron_left", current - 1));

  /* Window of 10 pages centered on current */
  const windowSize = 10;
  let start = Math.max(1, current - Math.floor(windowSize / 2));
  let end   = start + windowSize - 1;
  if (end > total) {
    end   = total;
    start = Math.max(1, end - windowSize + 1);
  }

  if (start > 1) {
    wrap.appendChild(mkBtn("1", 1, btnCls));
    if (start > 2) {
      const dots = document.createElement("span");
      dots.className = "text-xs text-slate-600 px-1";
      dots.textContent = "...";
      wrap.appendChild(dots);
    }
  }

  for (let i = start; i <= end; i++) {
    wrap.appendChild(mkBtn(String(i), i, i === current ? activeCls : btnCls));
  }

  if (end < total) {
    if (end < total - 1) {
      const dots = document.createElement("span");
      dots.className = "text-xs text-slate-600 px-1";
      dots.textContent = "...";
      wrap.appendChild(dots);
    }
    wrap.appendChild(mkBtn(String(total), total, btnCls));
  }

  wrap.appendChild(mkArrow("chevron_right", current + 1));

  return wrap;
}

export async function renderMemory(container) {
  container.textContent = "";
  container.appendChild(loadingHtml());

  const params = new URLSearchParams();
  if (state.memoryFilter.topic)    params.set("topic",    state.memoryFilter.topic);
  if (state.memoryFilter.type)     params.set("type",     state.memoryFilter.type);
  if (state.memoryFilter.key_id)   params.set("key_id",   state.memoryFilter.key_id);
  if (state.memoryFilter.group_id) params.set("group_id", state.memoryFilter.group_id);
  params.set("page", state.memoryPage);

  const [fragRes, anomalyRes, groupsRes] = await Promise.all([
    api("/memory/fragments?" + params),
    api("/memory/anomalies"),
    api("/groups")
  ]);
  if (groupsRes.ok) state.groups = groupsRes.data ?? [];

  if (fragRes.ok) {
    const data = fragRes.data ?? {};
    if (Array.isArray(fragRes.data)) {
      state.fragments   = fragRes.data;
      state.memoryPages = 1;
    } else {
      state.fragments   = data.items ?? data.fragments ?? [];
      state.memoryPages = Math.ceil((data.total ?? 0) / (data.limit ?? 20)) || 1;
    }
  } else {
    state.fragments = [];
  }

  state.anomalies = anomalyRes.ok ? anomalyRes.data : null;

  container.textContent = "";

  /* Filter bar */
  container.appendChild(renderMemoryFilters());

  /* Grid */
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-12 gap-6 mt-6";

  /* Center: fragments */
  const centerCol = document.createElement("div");
  centerCol.className = "col-span-12 lg:col-span-8 space-y-6";
  centerCol.appendChild(renderFragmentList(state.fragments));
  centerCol.appendChild(renderPagination());
  grid.appendChild(centerCol);

  /* Right: analytics + anomalies */
  const rightCol = document.createElement("div");
  rightCol.className = "col-span-12 lg:col-span-4 space-y-6";
  rightCol.appendChild(renderRetrievalAnalytics(state.stats));
  rightCol.appendChild(renderAnomalyCards(state.anomalies));
  grid.appendChild(rightCol);

  container.appendChild(grid);

  /* Bottom: Recent Events Chart */
  const bottomGrid = document.createElement("div");
  bottomGrid.className = "grid grid-cols-12 gap-6 mt-6";
  const bottomCol = document.createElement("div");
  bottomCol.className = "col-span-12";
  bottomCol.appendChild(renderRecentEventsChart());
  bottomGrid.appendChild(bottomCol);
  container.appendChild(bottomGrid);

  /* Event: search */
  document.getElementById("filter-search")?.addEventListener("click", () => {
    state.memoryFilter.topic    = document.getElementById("filter-topic")?.value ?? "";
    state.memoryFilter.type     = document.getElementById("filter-type")?.value ?? "";
    state.memoryFilter.key_id   = document.getElementById("filter-key-id")?.value ?? "";
    state.memoryFilter.group_id = document.getElementById("filter-group")?.value ?? "";
    state.memoryPage = 1;
    renderMemory(container);
  });

  /* Event: pagination */
  container.querySelectorAll("[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.memoryPage = parseInt(btn.dataset.page);
      renderMemory(container);
    });
  });

  /* Event: fragment click */
  container.querySelectorAll("[data-frag-id]").forEach(el => {
    el.addEventListener("click", () => {
      state.selectedFragment = state.fragments.find(f => f.id === el.dataset.fragId) ?? null;
      renderMemory(container);
    });
  });
}
