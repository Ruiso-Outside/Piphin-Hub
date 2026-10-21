// Interface do Piphin Hub: Início, Loja, Configurações, módulos e paleta de comandos (Ctrl+K).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1).replace(".", ",") + " GB" : (n / 1048576).toFixed(1).replace(".", ",") + " MB");
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "");
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const ls = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } } };

let snap = { apps: [], settings: {}, modules: [] };
let view = "home";
let storeFilter = "all";
let storeQuery = "";
let drawerId = null;
let collapsed = ls.get("collapsed", false);
const jobs = {}; // id -> { phase, pct, text }

// ------------------------------------------------------------------ dados
async function load() {
  const r = await hub.snapshot();
  if (!r.ok) return toast(r.error, "err");
  snap = r.data;
  if (modOf() && !(snap.modules || []).some((m) => m.id === modOf())) { view = "home"; hub.closeModule(); }
  for (const a of snap.apps) { if (a.job) jobs[a.id] = a.job; else if (jobs[a.id] && !jobs[a.id].local) delete jobs[a.id]; }
  render();
}
hub.onChanged(load);
hub.onOpenModule((id) => openModule(id));
hub.onProgress((p) => { jobs[p.id] = p; updateJobUi(p.id); });
hub.onSelfProgress((p) => { const el = $("#hubUpdate .progress > i"); if (el) el.style.width = Math.round((p || 0) * 100) + "%"; });
hub.onShortcut((k) => shortcut(k));

const app = (id) => snap.apps.find((a) => a.id === id);
const st = (a) => a.status || {};
const installedModules = () => (snap.modules || []).map((m) => ({ ...m, cat: app(m.id) })).filter((m) => m.cat || m.name);
const accentOf = (a) => (a && a.accent) || "#8b5cf6";
const iconOf = (a, m) => (a && a.iconUrl) || (m && m.icon) || null;

function stateOf(a) {
  const s = st(a);
  if (jobs[a.id]) return "busy";
  if (!a.status) return "loading";
  if (s.installed && s.updateAvailable) return "update";
  if (s.installed) return "installed";
  return "available";
}

// ------------------------------------------------------------------ ações
async function act(kind, id, opts = {}) {
  const a = app(id);
  if (kind === "install" || kind === "update") {
    jobs[id] = { phase: "start", pct: null, text: "Preparando...", local: true };
    render();
    const r = await hub.install(id, opts);
    delete jobs[id];
    if (!r.ok && r.code === "RUNNING") {
      if (await confirmBox(`${a.name} está aberto`, `Para ${kind === "update" ? "atualizar" : "reinstalar"}, o ${esc(a.name)} precisa ser fechado. Fechar agora e continuar?`, "Fechar e continuar"))
        return act(kind, id, { closeIfRunning: true });
      return load();
    }
    if (r.ok) toast(`${a.name} ${kind === "update" ? "atualizado" : "instalado"} · v${r.data.version}`, "ok");
    else if (r.error !== "Cancelado") toast(r.error, "err");
    return load();
  }
  if (kind === "launch" && a.kind === "module") return openModule(id);
  if (kind === "launch") {
    const r = await hub.launch(id);
    if (!r.ok) toast(r.error, "err"); else toast(`Abrindo ${a.name}...`);
    return;
  }
  if (kind === "uninstall") {
    const portable = a.install.type === "portable";
    const ok = await confirmBox(`Desinstalar ${a.name}?`,
      a.kind === "module" ? "O módulo vai para a Lixeira. Os dados dele (configurações e arquivos salvos) continuam no PC."
      : portable ? `A pasta <code>${esc(st(a).dir)}</code> vai para a Lixeira (dá para recuperar).${a.install.selfUpdating ? " Seus dados (modelos, conversas...) ficam na pasta de dados do app e não são apagados." : ""}`
        : `O desinstalador do ${esc(a.name)} será executado.`, "Desinstalar", true);
    if (!ok) return;
    jobs[id] = { phase: "uninstall", pct: null, text: "Desinstalando...", local: true };
    render();
    let r = await hub.uninstall(id, opts);
    if (!r.ok && r.code === "RUNNING") {
      delete jobs[id];
      if (!(await confirmBox(`${a.name} está aberto`, `Fechar o ${esc(a.name)} e continuar?`, "Fechar e continuar"))) return load();
      jobs[id] = { phase: "uninstall", pct: null, text: "Desinstalando...", local: true };
      render();
      r = await hub.uninstall(id, { closeIfRunning: true });
    }
    delete jobs[id];
    if (r.ok) toast(`${a.name} desinstalado`, "ok"); else toast(r.error, "err");
    return load();
  }
  const simple = { cancel: hub.cancel, folder: hub.openFolder, locate: hub.locate, forget: hub.forget, removeCustom: hub.removeCustom, restartModule: hub.restartModule };
  if (kind === "removeCustom" && !(await confirmBox(`Remover ${a.name} da Loja?`, "O app sai da lista do Hub. Se estiver instalado, os arquivos continuam no PC.", "Remover", true))) return;
  const r = await simple[kind](id);
  if (!r.ok) toast(r.error, "err");
  if (kind === "removeCustom") closeDrawer();
  if (kind === "locate" && r.ok && r.data) toast(`${a.name} encontrado`, "ok");
  if (kind === "restartModule" && r.ok) toast(`${a.name} reiniciado`, "ok");
  load();
}

async function updateAll() {
  for (const a of snap.apps.filter((x) => st(x).updateAvailable && !jobs[x.id])) await act("update", a.id);
}
async function checkUpdates() {
  toast("Verificando atualizações...");
  const r = await hub.refresh(true);
  if (!r.ok) return toast(r.error, "err");
  await load();
  const n = snap.apps.filter((a) => st(a).updateAvailable).length;
  toast(n ? `${n} atualização${n > 1 ? "ões" : ""} disponível${n > 1 ? "is" : ""}` : "Tudo atualizado", n ? "" : "ok");
}

// ------------------------------------------------------------------ navegação
const modOf = () => (view.startsWith("module:") ? view.slice(7) : null);

function go(v) {
  if (modOf() && !String(v).startsWith("module:")) hub.closeModule();
  view = v;
  closeDrawer();
  render(true);
}

async function openModule(id) {
  view = "module:" + id;
  closeDrawer();
  render(true);
  const r = await hub.openModule(id);
  if (!r.ok) { toast(r.error, "err"); view = "home"; render(true); }
}

function setCollapsed(on) {
  collapsed = on;
  ls.set("collapsed", on);
  document.body.classList.toggle("collapsed", on);
  $("#collapse").innerHTML = `<i class="i ${on ? "i-panel-left-open" : "i-panel-left-close"}"></i><span>Recolher</span>`;
  $("#collapse").title = on ? "Expandir a barra lateral" : "Recolher a barra lateral";
  // a área do módulo acompanha a largura da barra lateral (com a animação)
  setTimeout(() => hub.layout({ left: $("#side").getBoundingClientRect().width }), 240);
  hub.layout({ left: on ? 72 : 248 });
}

function shortcut(k) {
  if (k === "k") return openPalette();
  if (k === ",") return go("settings");
  const mods = installedModules();
  const m = mods[Number(k) - 1];
  if (m) openModule(m.id);
}

// ------------------------------------------------------------------ render
function render(fresh) {
  renderSide();
  const main = $("#main");
  const mid = modOf();
  if (mid) {
    const m = (snap.modules || []).find((x) => x.id === mid);
    const a = app(mid);
    main.innerHTML = `<div class="mod-loading"><div class="box">${iconOf(a, m) ? `<img src="${esc(iconOf(a, m))}" alt="">` : `<div class="spin"></div>`}
      <span>Abrindo ${esc((m && m.name) || (a && a.name) || "módulo")}...</span></div></div>`;
    return;
  }
  const scroll = fresh ? 0 : main.scrollTop;
  if (view === "home") renderHome(main);
  else if (view === "store") renderStore(main);
  else if (view === "settings") renderSettings(main);
  if (fresh) main.firstElementChild?.classList.add("p-enter");
  main.scrollTop = scroll;
  if (drawerId) renderDrawer();
}

function renderSide() {
  $$(".side .nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const updates = snap.apps.filter((a) => st(a).updateAvailable).length;
  $("#updCount").hidden = !updates;
  $("#updCount").textContent = updates;
  $("#hubVer").textContent = `v${snap.hubVersion || ""}`;
  const mods = installedModules();
  const cur = modOf();
  $("#modNav").innerHTML = mods.length ? mods.map((m, i) => {
    const icon = iconOf(m.cat, m);
    const stDot = { running: "ok", starting: "warn", crashed: "err" }[m.state] || "";
    return `<button class="nav-item ${m.id === cur ? "active" : ""}" data-mod="${esc(m.id)}" style="--accent-c:${esc(accentOf(m.cat || m))}" title="${esc(m.name)}${i < 9 ? ` (Ctrl+${i + 1})` : ""}">
      ${icon ? `<img class="mod-ico" src="${esc(icon)}" alt="">` : `<span class="mod-ico ph">${esc(m.name[0])}</span>`}<span>${esc(m.name)}</span>
      ${i < 9 ? `<span class="hk">^${i + 1}</span>` : ""}<i class="dot ${stDot}" title="${esc(m.error || m.state)}"></i></button>`;
  }).join("") : `<div class="side-empty">Nenhum módulo ainda. <a data-goto="store">Abra a Loja</a> para instalar.</div>`;
  renderHubUpdate();
}

function renderHubUpdate() {
  const box = $("#hubUpdate");
  const u = snap.hubUpdate;
  if (!u) { box.innerHTML = ""; box.dataset.k = ""; return; }
  const key = `${u.version}|${u.ready}|${u.error || ""}`;
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  if (u.ready) {
    box.innerHTML = `<div class="hub-update"><div class="row"><i class="i i-sparkles"></i><span class="hu-text"><b>Hub v${esc(u.version)}</b> pronto</span></div>
      <button class="btn primary sm" id="btnSelf" title="Reiniciar e atualizar"><i class="i i-refresh-cw"></i><span>Reiniciar agora</span></button></div>`;
    $("#btnSelf").onclick = async () => { const r = await hub.selfRestart(); if (!r.ok) toast(r.error, "err"); };
  } else if (u.error) {
    box.innerHTML = `<div class="hub-update"><div class="row"><i class="i i-triangle-alert"></i><span class="hu-text">Falha ao baixar o Hub v${esc(u.version)}</span></div>
      <button class="btn sm" id="btnSelf"><i class="i i-rotate-ccw"></i><span>Tentar de novo</span></button></div>`;
    $("#btnSelf").onclick = () => { box.dataset.k = ""; hub.selfCheck().then(load); };
  } else {
    box.innerHTML = `<div class="hub-update"><div class="row"><i class="i i-download"></i><span class="hu-text">Baixando o Hub v${esc(u.version)}...</span></div>
      <div class="progress"><i style="width:${Math.round((u.pct || 0) * 100)}%"></i></div></div>`;
  }
}

// ------------------------------------------------------------------ Início
const pulseHist = { cpu: [] };
let pulseData = null;
let pulseTimer = null;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Boa madrugada" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

function renderHome(main) {
  const mods = installedModules();
  const notInstalled = snap.apps.filter((a) => a.kind === "module" && !st(a).installed && !jobs[a.id]);
  const apps = snap.apps.filter((a) => a.kind !== "module" && st(a).installed);
  const updates = snap.apps.filter((a) => st(a).updateAvailable);
  const date = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  const p = pulseData;
  main.innerHTML = `<div class="p-page home">
    ${blockedBanner()}
    <section class="hero">
      <div><div class="hello">${greeting()}${p ? ", " + esc(p.user) : ""}</div><h1>O que vamos fazer hoje?</h1>
        <p>${esc(date.charAt(0).toUpperCase() + date.slice(1))}${p ? ` · ${esc(p.host)}` : ""}</p></div>
      <div class="pulse">
        <div class="pulse-tile"><div class="k"><i class="i i-cpu"></i>CPU</div><div class="v" id="pCpu">${p && p.cpu != null ? Math.round(p.cpu) : "--"}<small>%</small></div><canvas id="pCpuChart"></canvas></div>
        <div class="pulse-tile"><div class="k"><i class="i i-memory-stick"></i>Memória</div><div class="v" id="pRam">${p ? mb(p.ramUsed).replace(" GB", "") : "--"}<small>de ${p ? mb(p.ramTotal) : "--"}</small></div>
          <div class="bar"><i id="pRamBar" style="width:${p ? Math.round((p.ramUsed / p.ramTotal) * 100) : 0}%"></i></div></div>
        <div class="pulse-tile"><div class="k"><i class="i i-clock"></i>Ligado há</div><div class="v" id="pUp">${p ? uptime(p.uptime) : "--"}</div><div class="faint" style="font-size:12px">${p ? p.cores + " threads" : ""}</div></div>
      </div>
    </section>

    <div class="p-section">Seus módulos</div>
    ${mods.length ? `<div class="mod-grid">${mods.map((m, i) => modTile(m, i)).join("")}</div>`
      : `<div class="card flat" style="display:flex;align-items:center;gap:16px"><i class="i i-puzzle" style="font-size:28px;color:var(--p-accent-2)"></i>
          <div class="grow"><b>Monte o seu Piphin</b><div class="muted" style="font-size:13px">Cada ferramenta é um módulo que roda aqui dentro. Instale só o que você usa.</div></div>
          <button class="btn primary" data-goto="store"><i class="i i-store"></i>Abrir a Loja</button></div>`}
    ${notInstalled.length ? `<div class="p-section">Disponíveis para instalar</div><div class="mod-grid">${notInstalled.map(suggestTile).join("")}</div>` : ""}

    <div class="home-cols">
      <div class="card"><div class="card-title"><span><i class="i i-circle-arrow-up"></i> Atualizações</span>
        ${updates.length ? `<button class="btn sm primary" data-act-all="1"><i class="i i-download"></i>Atualizar tudo</button>` : `<button class="btn sm ghost" data-check="1"><i class="i i-refresh-cw"></i>Verificar</button>`}</div>
        ${updates.length ? updates.map((a) => `<div class="list-item">${iconOf(a) ? `<img src="${esc(iconOf(a))}" alt="">` : ""}<div class="t"><b>${esc(a.name)}</b>
          <span>v${esc(st(a).version)} → v${esc(st(a).latest.version)}</span></div>${primaryButton(a, true)}</div>`).join("")
          : `<div class="row muted" style="font-size:13px"><i class="i i-circle-check" style="color:var(--p-ok)"></i>Tudo em dia.${apps.length ? "" : ""}</div>`}
        ${apps.length ? `<div class="p-section" style="margin-top:18px">Apps separados</div>${apps.map((a) => `<div class="list-item">${iconOf(a) ? `<img src="${esc(iconOf(a))}" alt="">` : ""}
          <div class="t"><b>${esc(a.name)}</b><span>v${esc(st(a).version || "?")} · fora do Hub</span></div><button class="btn sm" data-act="launch" data-id="${esc(a.id)}"><i class="i i-external-link"></i>Abrir</button></div>`).join("")}` : ""}
      </div>
      <div class="card"><div class="card-title"><span><i class="i i-keyboard"></i> Atalhos</span></div>
        <div class="tips">
          <div><span>Pesquisar e executar</span><span><kbd>Ctrl</kbd><kbd>K</kbd></span></div>
          <div><span>Ir para um módulo</span><span><kbd>Ctrl</kbd><kbd>1</kbd>…<kbd>9</kbd></span></div>
          <div><span>Configurações</span><span><kbd>Ctrl</kbd><kbd>,</kbd></span></div>
          ${mods.some((m) => m.id === "llm-local") ? `<div><span>Pergunta rápida da IA</span><span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Espaço</kbd></span></div>` : ""}
          ${mods.some((m) => m.id === "infohardware") ? `<div><span>Overlay de jogo</span><span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>O</kbd></span></div>` : ""}
          ${mods.some((m) => m.id === "macro") ? `<div><span>Parar todas as macros</span><span><kbd>F12</kbd></span></div>` : ""}
        </div></div>
    </div>
  </div>`;
  drawPulse();
  startPulse();
}

// Hub extraído de um .zip baixado: com o Controle Inteligente de Aplicativos, o Windows bloqueia os atalhos
function blockedBanner() {
  if (!snap.hubBlocked) return "";
  return `<div class="p-banner zone-banner"><i class="i i-triangle-alert"></i>
    <div class="grow"><b>Os atalhos do Hub podem não abrir</b><div class="muted">Os arquivos do Hub vieram de um .zip baixado da internet, e por isso o Windows pode bloquear os atalhos da Área de Trabalho e do Menu Iniciar.
      Desbloquear tira essa marca só dos arquivos da pasta do Hub (é o mesmo que Propriedades → Desbloquear).</div></div>
    <button class="btn primary sm" data-unblock="1"><i class="i i-shield-check"></i>Desbloquear arquivos do Hub</button></div>`;
}
async function unblockHub(btn) {
  btn.disabled = true;
  const r = await hub.unblock();
  if (!r.ok) { btn.disabled = false; return toast(r.error, "err"); }
  toast("Arquivos do Hub desbloqueados. Os atalhos já devem abrir.", "ok");
  load();
}

function modTile(m, i) {
  const a = m.cat || {};
  const icon = iconOf(m.cat, m);
  const state = { running: ["ok", "Rodando"], starting: ["warn", "Iniciando"], crashed: ["err", "Parou"], stopped: ["", "Parado"] }[m.state] || ["", m.state];
  const keep = m.keepAlive ? ` · <span title="Continua funcionando com a janela fechada">ativo em segundo plano</span>` : "";
  return `<div class="mod-tile" data-mod="${esc(m.id)}" style="--accent-c:${esc(accentOf(a))}">
    <div class="top"><div class="ico">${icon ? `<img src="${esc(icon)}" alt="">` : ""}</div>${i < 9 ? `<span class="hint faint"><kbd>Ctrl</kbd> <kbd>${i + 1}</kbd></span>` : ""}</div>
    <div><h3>${esc(m.name)}</h3><p>${esc(shortDesc(a.description))}</p></div>
    <div class="foot"><span class="state"><i class="dot ${state[0]}"></i>${state[1]}${keep}</span><span class="go">Abrir<i class="i i-arrow-right"></i></span></div></div>`;
}
function suggestTile(a) {
  return `<div class="mod-tile suggest" style="--accent-c:${esc(accentOf(a))}">
    <div class="top"><div class="ico">${iconOf(a) ? `<img src="${esc(iconOf(a))}" alt="">` : ""}</div><span class="badge accent">${esc(a.category || "Módulo")}</span></div>
    <div><h3>${esc(a.name)}</h3><p>${esc(shortDesc(a.description))}</p></div>
    <div class="foot"><span class="faint" style="font-size:12px">${st(a).latest ? "v" + esc(st(a).latest.version) + (st(a).latest.size ? " · " + mb(st(a).latest.size) : "") : ""}</span>${primaryButton(a, true)}</div></div>`;
}
const shortDesc = (d) => String(d || "").replace(/\s*Roda dentro do Hub.*$/, "");
const uptime = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m} min`; };

async function pulseTick() {
  if (view !== "home") return stopPulse();
  const r = await hub.pulse();
  if (!r.ok) return;
  pulseData = r.data;
  if (pulseData.cpu != null) { pulseHist.cpu.push(pulseData.cpu); if (pulseHist.cpu.length > 40) pulseHist.cpu.shift(); }
  const p = pulseData;
  if ($("#pCpu")) {
    $("#pCpu").innerHTML = `${p.cpu != null ? Math.round(p.cpu) : "--"}<small>%</small>`;
    $("#pRam").innerHTML = `${mb(p.ramUsed).replace(" GB", "")}<small>de ${mb(p.ramTotal)}</small>`;
    $("#pRamBar").style.width = Math.round((p.ramUsed / p.ramTotal) * 100) + "%";
    $("#pUp").textContent = uptime(p.uptime);
    drawPulse();
  } else if (view === "home") render();
}
function startPulse() { if (!pulseTimer) { pulseTick(); pulseTimer = setInterval(pulseTick, 1500); } }
function stopPulse() { clearInterval(pulseTimer); pulseTimer = null; }
function drawPulse() {
  const c = $("#pCpuChart");
  if (!c) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const d = pulseHist.cpu;
  if (d.length < 2) return;
  const top = Math.max(10, Math.max(...d) * 1.3); // escala automática: a linha não fica colada no fundo
  const x = (i) => (i / 39) * w, y = (v) => h - 2 - (Math.min(v, top) / top) * (h - 4);
  const off = 40 - d.length;
  g.beginPath();
  d.forEach((v, i) => (i ? g.lineTo(x(i + off), y(v)) : g.moveTo(x(i + off), y(v))));
  const grad = g.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, "#7c3aed"); grad.addColorStop(1, "#c084fc");
  g.strokeStyle = grad; g.lineWidth = 2; g.lineJoin = "round"; g.stroke();
  g.lineTo(x(39), h); g.lineTo(x(off), h); g.closePath();
  const fill = g.createLinearGradient(0, 0, 0, h); fill.addColorStop(0, "rgba(168,85,247,.35)"); fill.addColorStop(1, "rgba(168,85,247,0)");
  g.fillStyle = fill; g.fill();
}

// ------------------------------------------------------------------ Loja
const FILTERS = [["all", "Tudo"], ["modules", "Módulos"], ["apps", "Apps"], ["installed", "Instalados"], ["updates", "Atualizações"]];
function storeList(f = storeFilter) {
  const q = norm(storeQuery);
  return snap.apps.filter((a) => {
    const s = st(a);
    if (f === "modules" && a.kind !== "module") return false;
    if (f === "apps" && a.kind === "module") return false;
    if (f === "installed" && !s.installed) return false;
    if (f === "updates" && !s.updateAvailable) return false;
    return !q || norm(a.name + " " + a.description + " " + a.category).includes(q);
  }).sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name, "pt-BR") : x.kind === "module" ? -1 : 1));
}

function renderStore(main) {
  const focused = document.activeElement && document.activeElement.id === "storeSearch";
  const list = storeList();
  main.innerHTML = `<div class="p-page">
    <div class="p-head"><div><h1>Loja</h1><p>Módulos rodam dentro do Hub; apps abrem separados. Tudo vem dos Releases do GitHub.</p></div>
      <div class="actions"><label class="search"><i class="i i-search"></i><input id="storeSearch" type="search" placeholder="Buscar" value="${esc(storeQuery)}" style="width:220px"></label>
        <button class="btn" data-check="1"><i class="i i-refresh-cw"></i>Verificar</button>
        ${snap.apps.some((a) => st(a).updateAvailable) ? `<button class="btn primary" data-act-all="1"><i class="i i-download"></i>Atualizar tudo</button>` : ""}</div></div>
    <div class="chips" style="margin-bottom:18px">${FILTERS.map(([k, n]) => { const c = storeList(k).length;
      return `<button class="chip ${storeFilter === k ? "active" : ""}" data-filter="${k}">${n}<span class="count">${c}</span></button>`; }).join("")}</div>
    ${list.length ? `<div class="store-grid">${list.map(storeCard).join("")}${storeFilter === "all" || storeFilter === "apps" ? addTile() : ""}</div>`
      : `<div class="p-empty"><i class="i i-${storeFilter === "updates" ? "circle-check" : "search"}"></i><h3>${storeFilter === "updates" ? "Tudo em dia" : "Nada encontrado"}</h3>
         <span>${storeFilter === "updates" ? "Nenhuma atualização pendente." : "Tente outro termo ou filtro."}</span></div>`}
  </div>`;
  const inp = $("#storeSearch");
  inp.oninput = (e) => { storeQuery = e.target.value; render(); };
  if (focused) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
}

function statusBadge(a) {
  const s = st(a);
  if (!a.status) return `<span class="badge off">verificando</span>`;
  if (a.kind === "module" && s.installed && s.moduleState === "crashed") return `<span class="badge err" title="${esc(s.moduleError || "")}">parou</span>`;
  if (s.updateAvailable) return `<span class="badge warn">v${esc(s.latest.version)} nova</span>`;
  if (s.installed) return `<span class="badge ok"><i class="i i-check"></i>instalado</span>`;
  if (s.latestError) return `<span class="badge err" title="${esc(s.latestError)}">indisponível</span>`;
  return "";
}

function primaryButton(a, sm) {
  const s = st(a), cls = sm ? " sm" : "";
  switch (stateOf(a)) {
    case "busy": return jobs[a.id].phase === "download" ? `<button class="btn${cls}" data-act="cancel" data-id="${a.id}"><i class="i i-x"></i>Cancelar</button>` : `<button class="btn${cls}" disabled><span class="spin" style="width:14px;height:14px"></span>Aguarde</button>`;
    case "update": return `<button class="btn primary${cls}" data-act="update" data-id="${a.id}"><i class="i i-download"></i>Atualizar</button>`;
    case "installed": return `<button class="btn primary${cls}" data-act="launch" data-id="${a.id}"><i class="i i-${a.kind === "module" ? "arrow-right" : "external-link"}"></i>Abrir</button>`;
    case "loading": return `<button class="btn${cls}" disabled>...</button>`;
    default: return `<button class="btn primary${cls}" data-act="install" data-id="${a.id}" ${s.latest ? "" : "disabled"}><i class="i i-download"></i>Instalar</button>`;
  }
}

function jobHtml(a) {
  const j = jobs[a.id];
  if (!j) return "";
  const pct = j.pct == null ? null : Math.round(j.pct * 100);
  return `<div class="job" data-job="${a.id}"><div class="progress ${pct == null ? "indet" : ""}"><i style="width:${pct ?? 0}%"></i></div>
    <div class="job-text"><span class="jt">${esc(j.text || "")}</span><span class="jp">${pct == null ? "" : pct + "%"}</span></div></div>`;
}

function storeCard(a) {
  const s = st(a);
  const ver = s.installed ? `v<b>${esc(s.version || "?")}</b>${s.updateAvailable ? ` → <b>${esc(s.latest.version)}</b>` : ""}`
    : s.latest ? `v<b>${esc(s.latest.version)}</b>${s.latest.size ? " · " + mb(s.latest.size) : ""}` : "";
  return `<div class="store-card" data-open="${a.id}" style="--accent-c:${esc(accentOf(a))}">
    <div class="cover"><div class="tags"><span class="badge">${a.kind === "module" ? `<i class="i i-puzzle"></i>Módulo` : `<i class="i i-app-window"></i>App`}</span>${a.origin === "custom" ? `<span class="badge info">seu</span>` : ""}</div>
      <div class="ico">${iconOf(a) ? `<img src="${esc(iconOf(a))}" alt="">` : `<span class="ph">${esc(a.name[0])}</span>`}</div></div>
    <div class="body"><div class="row" style="justify-content:space-between"><h3>${esc(a.name)}</h3>${statusBadge(a)}</div>
      <div class="cat">${esc(a.category || "Outros")}</div>
      <p class="desc">${esc(shortDesc(a.description))}</p>
      ${jobHtml(a)}
      <div class="foot"><span class="ver">${ver}</span>${primaryButton(a, true)}</div></div></div>`;
}
const addTile = () => `<div class="add-tile" data-add="1"><div><i class="i i-plus"></i><div><b>Adicionar app</b></div><div style="font-size:12px;margin-top:4px">De um repositório do GitHub ou de uma pasta</div></div></div>`;

// atualiza só a barra de progresso (sem redesenhar a tela inteira)
function updateJobUi(id) {
  const els = $$(`[data-job="${id}"]`);
  if (!els.length) return render();
  const j = jobs[id];
  const pct = j.pct == null ? null : Math.round(j.pct * 100);
  els.forEach((el) => {
    const bar = $(".progress", el);
    bar.classList.toggle("indet", pct == null);
    $("i", bar).style.width = (pct ?? 0) + "%";
    $(".jt", el).textContent = j.text || "";
    $(".jp", el).textContent = pct == null ? "" : pct + "%";
  });
  $$(`[data-open="${id}"] .foot .btn, .drawer .actions .btn[data-main]`).forEach((b) => {
    const want = j.phase === "download" ? "cancel" : "";
    if ((b.dataset.act || "") !== want) b.outerHTML = primaryButton(app(id), b.classList.contains("sm"));
  });
}

// ------------------------------------------------------------------ detalhes
function openDrawer(id) { drawerId = id; renderDrawer(); }
function closeDrawer() { drawerId = null; $("#drawer").hidden = true; }

async function renderDrawer() {
  const a = app(drawerId);
  if (!a) return closeDrawer();
  const s = st(a), d = $("#drawer");
  d.hidden = false;
  d.style.setProperty("--accent-c", accentOf(a));
  const src = a.source.type === "github" ? `<a href="https://github.com/${esc(a.source.repo)}" target="_blank">${esc(a.source.repo)}</a>` : esc(a.source.path);
  const more = [];
  if (s.installed) {
    if (a.kind !== "module") more.push(`<button class="btn" data-act="folder" data-id="${a.id}"><i class="i i-folder-open"></i>Pasta</button>`);
    if (a.kind === "module") more.push(`<button class="btn" data-act="restartModule" data-id="${a.id}"><i class="i i-rotate-ccw"></i>Reiniciar módulo</button>`);
    if (!s.updateAvailable && s.latest) more.push(`<button class="btn" data-act="install" data-id="${a.id}"><i class="i i-refresh-cw"></i>Reinstalar</button>`);
    more.push(`<button class="btn danger" data-act="uninstall" data-id="${a.id}"><i class="i i-trash-2"></i>Desinstalar</button>`);
  } else if (a.install.type === "portable") {
    more.push(`<button class="btn" data-act="locate" data-id="${a.id}" title="Já tem este app numa pasta? Aponte para ela"><i class="i i-folder-open"></i>Já tenho instalado</button>`);
  }
  if (s.latest && s.latest.page) more.push(`<a class="btn ghost" href="${esc(s.latest.page)}" target="_blank"><i class="i i-external-link"></i>GitHub</a>`);
  if (a.origin === "custom") more.push(`<button class="btn danger" data-act="removeCustom" data-id="${a.id}"><i class="i i-x"></i>Remover da Loja</button>`);

  d.innerHTML = `<div class="cover"><button class="btn icon sm close" data-close="1" title="Fechar"><i class="i i-x"></i></button></div>
    <div class="head"><div class="ico">${iconOf(a) ? `<img src="${esc(iconOf(a))}" alt="">` : ""}</div>
      <div style="padding-bottom:6px"><h2>${esc(a.name)}</h2><div class="row" style="margin-top:6px"><span class="badge">${a.kind === "module" ? "Módulo" : "App"}</span>
      <span class="badge">${esc(a.category || "Outros")}</span>${statusBadge(a)}</div></div></div>
    <div class="inner">
      <p class="desc">${esc(a.description || "")}</p>
      ${jobHtml(a)}
      <div class="actions" style="margin-top:12px"><span data-main>${primaryButton(a)}</span>${more.join("")}</div>
      ${s.latestError ? `<div class="error-box" style="margin-bottom:16px">Não foi possível consultar a versão mais recente: ${esc(s.latestError)}</div>` : ""}
      <dl class="kv">
        <dt>Instalada</dt><dd>${s.installed ? "v" + esc(s.version || "?") : "—"}</dd>
        <dt>Mais recente</dt><dd>${s.latest ? "v" + esc(s.latest.version) + (s.latest.publishedAt ? ` <span class="faint">· ${fmtDate(s.latest.publishedAt)}</span>` : "") : "—"}</dd>
        ${s.latest && s.latest.size ? `<dt>Download</dt><dd>${mb(s.latest.size)}</dd>` : ""}
        ${s.installed ? `<dt>Pasta</dt><dd class="mono" style="font-size:12px">${esc(s.dir)}</dd><dt>Espaço em disco</dt><dd id="dsize">calculando...</dd>` : ""}
        <dt>Origem</dt><dd>${src}</dd>
        <dt>Tipo</dt><dd>${a.kind === "module" ? "Módulo (roda dentro do Hub)" : a.install.type === "portable" ? "App portátil (pasta)" : "App com instalador"}${a.install.selfUpdating ? " · também se atualiza sozinho" : ""}</dd>
      </dl>
      ${s.latest && s.latest.notes ? `<div class="p-section">Novidades da v${esc(s.latest.version)}</div><div class="notes">${esc(s.latest.notes)}</div>` : ""}
    </div>`;
  $$("[data-main] .btn", d).forEach((b) => (b.dataset.main = "1"));
  if (s.installed) { const r = await hub.folderSize(a.id); const el = $("#dsize"); if (el && r.ok) el.textContent = mb(r.data); }
}

// ------------------------------------------------------------------ configurações
function renderSettings(main) {
  const s = snap.settings;
  const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><span></span></label>`;
  const row = (icon, title, text, ctrl) => `<div class="set"><div class="ico-left"><i class="i i-${icon}"></i><div><h4>${title}</h4><p>${text}</p></div></div><div class="ctrl">${ctrl}</div></div>`;
  main.innerHTML = `<div class="p-page"><div class="p-head"><div><h1>Configurações</h1><p>Preferências do Piphin Hub.</p></div></div>
    <div class="p-settings">
      <div class="p-section">Geral</div>
      ${row("power", "Iniciar com o Windows", "Abre o Hub escondido perto do relógio quando o PC liga, para os atalhos dos módulos funcionarem desde o início.", sw("sBoot", s.startWithWindows))}
      ${row("app-window", "Atalhos do Piphin Hub", "Cria ou recria os atalhos do Hub na Área de Trabalho e no Menu Iniciar.", `<button class="btn" id="sHubLnk">Criar atalhos</button>`)}
      ${row("monitor", "Atalho dos apps na Área de Trabalho", "Ao instalar um app portátil, cria também um atalho na Área de Trabalho.", sw("sDesk", s.desktopShortcuts))}

      <div class="p-section">Atualizações</div>
      ${row("sparkles", `Piphin Hub v${esc(snap.hubVersion)}`, "O Hub se atualiza sozinho: consulta o GitHub ao abrir e a cada hora e pergunta se pode reiniciar.", `<button class="btn" id="sSelf"><i class="i i-refresh-cw"></i>Verificar agora</button>`)}
      ${row("bell", "Verificar módulos e apps ao abrir", "Consulta o GitHub ao abrir o Hub e a cada 6 horas.", sw("sCheck", s.checkOnStart))}
      ${row("download", "Atualizar automaticamente", "Instala as versões novas sozinho. Apps abertos ficam para a próxima verificação.", sw("sAuto", s.autoUpdate))}

      <div class="p-section">Apps</div>
      <div class="set"><div class="ico-left"><i class="i i-folder-open"></i><div><h4>Pasta dos apps portáteis</h4><p>Onde o Hub instala apps que vêm em .zip. Módulos ficam na pasta do Hub.</p></div></div>
        <div class="wide"><input type="text" id="sLib" value="${esc(s.libraryDir)}"><button class="btn" id="sLibPick">Escolher</button></div></div>

      <div class="p-section">Avançado</div>
      <div class="set"><div class="ico-left"><i class="i i-database"></i><div><h4>Catálogo online</h4><p>Lista de módulos e apps. Publicar um item novo nele faz ele aparecer na Loja de todos os PCs.</p></div></div>
        <div class="wide"><input type="text" id="sCat" value="${esc(s.catalogUrl)}"></div></div>
      <div class="set"><div class="ico-left"><i class="i i-lock"></i><div><h4>Token do GitHub (opcional)</h4><p>Só para repositórios privados ou se o limite de consultas (60 por hora) for atingido.</p></div></div>
        <div class="wide"><input type="password" id="sTok" value="${esc(s.githubToken)}" placeholder="ghp_..." autocomplete="off"></div></div>
    </div></div>`;
  const save = async (patch, msg = "Configuração salva") => { const r = await hub.setSettings(patch); if (!r.ok) toast(r.error, "err"); else { toast(msg, "ok"); load(); } };
  $("#sBoot").onchange = (e) => save({ startWithWindows: e.target.checked });
  $("#sHubLnk").onclick = async () => { const r = await hub.hubShortcuts(); toast(r.ok ? "Atalhos do Hub criados" : r.error, r.ok ? "ok" : "err"); };
  $("#sDesk").onchange = (e) => save({ desktopShortcuts: e.target.checked });
  $("#sSelf").onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    const r = await hub.selfCheck(); b.disabled = false;
    if (!r.ok) toast(r.error, "err"); else if (!r.data) toast("O Hub já está na versão mais recente", "ok");
    load();
  };
  $("#sCheck").onchange = (e) => save({ checkOnStart: e.target.checked });
  $("#sAuto").onchange = (e) => save({ autoUpdate: e.target.checked });
  $("#sLib").onchange = (e) => save({ libraryDir: e.target.value.trim() });
  $("#sLibPick").onclick = async () => { const r = await hub.pickFolder("Pasta dos apps"); if (r.ok && r.data) save({ libraryDir: r.data }); };
  $("#sCat").onchange = (e) => save({ catalogUrl: e.target.value.trim() });
  $("#sTok").onchange = (e) => save({ githubToken: e.target.value.trim() });
}

// ------------------------------------------------------------------ adicionar app
function openAddForm() {
  const f = { sourceType: "github", installType: "portable" };
  const box = $("#modalBox");
  box.innerHTML = `<h3>Adicionar app</h3><p style="font-size:13px">O Hub baixa a versão mais recente do Release do GitHub (ou da pasta) e cuida das atualizações.</p>
    <div class="form">
      <div class="two"><label>Nome<input type="text" id="fName" placeholder="AutoClick"></label><label>Categoria<input type="text" id="fCat" placeholder="Produtividade"></label></div>
      <label>Descrição<input type="text" id="fDesc" placeholder="O que o app faz"></label>
      <label>Origem<div class="seg" id="fSrc"><button data-v="github" class="on">Release do GitHub</button><button data-v="local">Pasta local</button></div></label>
      <label id="lRepo">Repositório<input type="text" id="fRepo" placeholder="Ruiso-Outside/AutoClick"></label>
      <label id="lLocal" hidden>Pasta com os arquivos (.zip/.exe)<div class="row"><input type="text" id="fLocal" style="flex:1"><button class="btn" id="fLocalPick">...</button></div></label>
      <label>Tipo de pacote<div class="seg" id="fType"><button data-v="portable" class="on">.zip portátil</button><button data-v="installer">Instalador .exe</button></div></label>
      <div class="two"><label>Arquivo do Release (regex)<input type="text" id="fAsset" placeholder="win-x64\\.zip$"></label><label>Executável do app<input type="text" id="fExe" placeholder="AutoClick.exe"></label></div>
      <div class="two" id="lInst" hidden><label>Argumentos silenciosos<input type="text" id="fSilent" placeholder="/S"></label><label>Chave de desinstalação<input type="text" id="fKey" placeholder="(opcional)"></label></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="fCancel">Cancelar</button><button class="btn primary" id="fSave"><i class="i i-plus"></i>Adicionar</button></div>`;
  const seg = (sel, key, after) => $$(sel + " button", box).forEach((b) => (b.onclick = (e) => {
    e.preventDefault(); f[key] = b.dataset.v;
    $$(sel + " button", box).forEach((x) => x.classList.toggle("on", x === b)); after();
  }));
  seg("#fSrc", "sourceType", () => { $("#lRepo").hidden = f.sourceType !== "github"; $("#lLocal").hidden = f.sourceType !== "local"; });
  seg("#fType", "installType", () => { $("#lInst").hidden = f.installType !== "installer"; });
  $("#fLocalPick").onclick = async (e) => { e.preventDefault(); const r = await hub.pickFolder(); if (r.ok && r.data) $("#fLocal").value = r.data; };
  $("#fCancel").onclick = () => closeModal();
  $("#fSave").onclick = async () => {
    const r = await hub.addCustom({ ...f, name: $("#fName").value, category: $("#fCat").value, description: $("#fDesc").value,
      repo: $("#fRepo").value, localPath: $("#fLocal").value, asset: $("#fAsset").value, exe: $("#fExe").value,
      silentArgs: $("#fSilent").value, uninstallKey: $("#fKey").value.trim() });
    if (!r.ok) return toast(r.error, "err");
    closeModal(); toast("App adicionado à Loja", "ok"); load();
  };
  showModal();
  $("#fName").focus();
}

// ------------------------------------------------------------------ modal e avisos
// a área do módulo fica por cima da janela: some enquanto um modal ou a paleta estiver aberto
let overlays = 0;
const cover = (on) => { overlays = Math.max(0, overlays + (on ? 1 : -1)); hub.layout({ covered: overlays > 0 }); };
let modalResolve = null;
function showModal() { if ($("#modal").hidden) cover(true); $("#modal").hidden = false; }
function confirmBox(title, html, okText = "Confirmar", danger = false) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $("#modalBox").innerHTML = `<h3>${esc(title)}</h3><p>${html}</p><div class="modal-actions">
      <button class="btn ghost" id="mNo">Cancelar</button><button class="btn ${danger ? "danger solid" : "primary"}" id="mYes">${esc(okText)}</button></div>`;
    showModal();
    $("#mNo").onclick = () => closeModal(false);
    $("#mYes").onclick = () => closeModal(true);
    $("#mYes").focus();
  });
}
function closeModal(v = false) {
  if (!$("#modal").hidden) cover(false);
  $("#modal").hidden = true;
  if (modalResolve) { modalResolve(v); modalResolve = null; }
}
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), kind === "err" ? 7000 : 3500);
}

// ------------------------------------------------------------------ paleta de comandos (Ctrl+K)
let palItems = [], palSel = 0;
function paletteCommands() {
  const cmds = [];
  installedModules().forEach((m, i) => cmds.push({ group: "Módulos", label: m.name, sub: "abrir", icon: iconOf(m.cat, m), hint: i < 9 ? `Ctrl ${i + 1}` : "", run: () => openModule(m.id), keys: "abrir modulo " + m.id }));
  cmds.push({ group: "Ir para", label: "Início", ico: "house", run: () => go("home") });
  cmds.push({ group: "Ir para", label: "Loja", ico: "store", run: () => go("store"), keys: "explorar instalar baixar" });
  cmds.push({ group: "Ir para", label: "Configurações", ico: "settings", hint: "Ctrl ,", run: () => go("settings"), keys: "preferencias opcoes" });
  const upd = snap.apps.filter((a) => st(a).updateAvailable);
  if (upd.length) cmds.push({ group: "Ações", label: `Atualizar tudo (${upd.length})`, ico: "download", run: updateAll });
  cmds.push({ group: "Ações", label: "Verificar atualizações", ico: "refresh-cw", run: checkUpdates, keys: "update" });
  cmds.push({ group: "Ações", label: collapsed ? "Expandir a barra lateral" : "Recolher a barra lateral", ico: collapsed ? "panel-left-open" : "panel-left-close", run: () => setCollapsed(!collapsed) });
  cmds.push({ group: "Ações", label: "Adicionar app à Loja", ico: "plus", run: () => { go("store"); openAddForm(); } });
  if (snap.hubUpdate && snap.hubUpdate.ready) cmds.push({ group: "Ações", label: `Reiniciar e atualizar o Hub (v${snap.hubUpdate.version})`, ico: "sparkles", run: () => hub.selfRestart() });
  for (const a of snap.apps) {
    const s = st(a);
    if (a.kind !== "module" && s.installed) cmds.push({ group: "Apps", label: a.name, sub: "abrir", icon: iconOf(a), run: () => act("launch", a.id) });
    if (!s.installed && s.latest && !jobs[a.id]) cmds.push({ group: "Instalar", label: a.name, sub: a.kind === "module" ? "módulo" : "app", icon: iconOf(a), run: () => act("install", a.id) });
    if (s.updateAvailable) cmds.push({ group: "Atualizar", label: a.name, sub: `v${s.version} → v${s.latest.version}`, icon: iconOf(a), run: () => act("update", a.id) });
  }
  return cmds;
}
function openPalette() {
  if (!$("#palette").hidden) return;
  cover(true);
  $("#palette").hidden = false;
  $("#paletteInput").value = "";
  filterPalette();
  setTimeout(() => $("#paletteInput").focus(), 0);
}
function closePalette() { if ($("#palette").hidden) return; $("#palette").hidden = true; cover(false); }
function filterPalette() {
  const q = norm($("#paletteInput").value.trim());
  const words = q.split(/\s+/).filter(Boolean);
  palItems = paletteCommands().map((c) => {
    const hay = norm(`${c.label} ${c.sub || ""} ${c.group} ${c.keys || ""}`);
    if (words.some((w) => !hay.includes(w))) return null;
    const l = norm(c.label);
    return { ...c, score: !q ? 0 : l.startsWith(q) ? 3 : l.includes(q) ? 2 : 1 };
  }).filter(Boolean);
  if (q) palItems.sort((a, b) => b.score - a.score);
  palSel = 0;
  renderPalette();
}
function renderPalette() {
  const list = $("#paletteList");
  if (!palItems.length) { list.innerHTML = `<div class="palette-empty">Nada encontrado</div>`; return; }
  let html = "", group = null;
  palItems.forEach((c, i) => {
    if (c.group !== group) { group = c.group; html += `<div class="palette-group">${esc(group)}</div>`; }
    html += `<div class="palette-item ${i === palSel ? "sel" : ""}" data-pi="${i}"><span class="pi-ico">${c.icon ? `<img src="${esc(c.icon)}" alt="">` : `<i class="i i-${c.ico || "arrow-right"}"></i>`}</span>
      <span class="label">${esc(c.label)}${c.sub ? `<small>${esc(c.sub)}</small>` : ""}</span>${c.hint ? `<span class="hint">${c.hint.split(" ").map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span>` : ""}</div>`;
  });
  list.innerHTML = html;
  $(".palette-item.sel", list)?.scrollIntoView({ block: "nearest" });
}
function runPalette(i) {
  const c = palItems[i];
  if (!c) return;
  closePalette();
  setTimeout(() => c.run(), 0);
}
$("#paletteInput").addEventListener("input", filterPalette);
$("#paletteInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); renderPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(0, palSel - 1); renderPalette(); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(palSel); }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
});
$("#paletteList").addEventListener("mousemove", (e) => { const it = e.target.closest("[data-pi]"); if (it && +it.dataset.pi !== palSel) { palSel = +it.dataset.pi; renderPalette(); } });
$("#paletteList").addEventListener("click", (e) => { const it = e.target.closest("[data-pi]"); if (it) runPalette(+it.dataset.pi); });
$("#palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") closePalette(); });
$("#cmdOpen").onclick = openPalette;

// ------------------------------------------------------------------ eventos
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[href^='https://']");
  if (link) { e.preventDefault(); hub.openUrl(link.href); return; }
  const btn = e.target.closest("[data-act]");
  if (btn) { e.stopPropagation(); act(btn.dataset.act, btn.dataset.id); return; }
  if (e.target.closest("[data-act-all]")) return updateAll();
  if (e.target.closest("[data-check]")) return checkUpdates();
  const unb = e.target.closest("[data-unblock]");
  if (unb) return unblockHub(unb);
  const nav = e.target.closest("[data-view]");
  if (nav) return go(nav.dataset.view);
  const goto = e.target.closest("[data-goto]");
  if (goto) return go(goto.dataset.goto);
  const mod = e.target.closest("[data-mod]");
  if (mod) return openModule(mod.dataset.mod);
  const filt = e.target.closest("[data-filter]");
  if (filt) { storeFilter = filt.dataset.filter; return render(); }
  if (e.target.closest("[data-add]")) return openAddForm();
  const card = e.target.closest("[data-open]");
  if (card) return openDrawer(card.dataset.open);
  if (e.target.closest("[data-close]")) return closeDrawer();
  if (e.target.id === "modal") closeModal(false);
});
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "k" || k === "," || (/^[1-9]$/.test(k) && !e.shiftKey)) { e.preventDefault(); return shortcut(k); }
  }
  if (e.key === "Escape") { if (!$("#modal").hidden) closeModal(false); else closeDrawer(); }
});
$("#collapse").onclick = () => setCollapsed(!collapsed);
window.addEventListener("resize", () => { if (view === "home") drawPulse(); });

setCollapsed(collapsed);
load();
