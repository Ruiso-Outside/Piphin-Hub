// Interface do Piphin Hub.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : (n / 1048576).toFixed(1) + " MB");
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "");

let snap = { apps: [], settings: {} };
let view = "library";
let category = "Todos";
let drawerId = null;
const jobs = {}; // id -> { phase, pct, text }

const VIEWS = {
  library: ["Biblioteca", "Seus apps instalados"],
  explore: ["Explorar", "Todos os apps disponíveis no Hub"],
  updates: ["Atualizações", "Versões novas prontas para instalar"],
  settings: ["Configurações", "Preferências do Hub"],
};

// ------------------------------------------------------------------ dados
async function load() {
  const r = await hub.snapshot();
  if (!r.ok) return toast(r.error, "err");
  snap = r.data;
  for (const a of snap.apps) { if (a.job) jobs[a.id] = a.job; else if (jobs[a.id] && !jobs[a.id].local) delete jobs[a.id]; }
  render();
}

hub.onChanged(load);
hub.onProgress((p) => {
  jobs[p.id] = p;
  updateJobUi(p.id);
});
hub.onSelfProgress((p) => {
  const el = $("#hubUpdate .progress > i");
  if (el) el.style.width = Math.round((p || 0) * 100) + "%";
});

const app = (id) => snap.apps.find((a) => a.id === id);
const st = (a) => a.status || {};

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
    if (r.ok) toast(`${a.name} ${kind === "update" ? "atualizado" : "instalado"} (v${r.data.version})`, "ok");
    else if (r.error !== "Cancelado") toast(r.error, "err");
    return load();
  }
  if (kind === "launch") {
    const r = await hub.launch(id);
    if (!r.ok) toast(r.error, "err"); else toast(`Abrindo ${a.name}...`);
    return;
  }
  if (kind === "uninstall") {
    const portable = a.install.type === "portable";
    const ok = await confirmBox(`Desinstalar ${a.name}?`,
      portable ? `A pasta <code>${esc(st(a).dir)}</code> vai para a Lixeira (dá para recuperar).${a.install.selfUpdating ? " Seus dados (modelos, conversas...) ficam na pasta de dados do app e não são apagados." : ""}`
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
    if (r.ok) { toast(`${a.name} desinstalado`, "ok"); } else toast(r.error, "err");
    return load();
  }
  const simple = { cancel: hub.cancel, folder: hub.openFolder, locate: hub.locate, forget: hub.forget, removeCustom: hub.removeCustom };
  if (kind === "removeCustom" && !(await confirmBox(`Remover ${a.name} do Hub?`, "O app sai da lista do Hub. Se estiver instalado, os arquivos continuam no PC.", "Remover", true))) return;
  const r = await simple[kind](id);
  if (!r.ok) toast(r.error, "err");
  if (kind === "removeCustom") closeDrawer();
  if (kind === "locate" && r.ok && r.data) toast(`${a.name} encontrado`, "ok");
  load();
}

async function updateAll() {
  const list = snap.apps.filter((a) => st(a).updateAvailable && !jobs[a.id]);
  for (const a of list) await act("update", a.id);
}

// ------------------------------------------------------------------ render
function render() {
  const [title, sub] = VIEWS[view];
  $("#viewTitle").textContent = title;
  $("#viewSub").textContent = sub;
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === view));

  const updates = snap.apps.filter((a) => st(a).updateAvailable);
  $("#updBadge").hidden = !updates.length;
  $("#updBadge").textContent = updates.length;
  $("#btnUpdateAll").hidden = !updates.length || view === "settings";
  $("#btnUpdateAll").textContent = `Atualizar tudo (${updates.length})`;
  $("#search").hidden = $("#btnCheck").hidden = view === "settings";
  $("#hubVer").textContent = `Piphin Hub v${snap.hubVersion || ""}`;
  renderHubUpdate();

  if (view === "settings") { $("#chips").innerHTML = ""; renderSettings(); }
  else renderGrid();
  if (drawerId) renderDrawer();
}

function renderHubUpdate() {
  const box = $("#hubUpdate");
  if (!snap.hubUpdate) { box.hidden = true; return; }
  box.hidden = false;
  const u = snap.hubUpdate;
  const key = `${u.version}|${u.ready}|${u.error || ""}`;
  if (box.dataset.k === key) return; // só o progresso muda (onSelfProgress)
  box.dataset.k = key;
  if (u.ready) {
    box.innerHTML = `<b>Hub v${esc(u.version)}</b> pronto para usar<button class="btn primary sm" id="btnSelf">Reiniciar agora</button>
      <div class="muted" style="font-size:11.5px;margin-top:6px">Ou ele entra quando você fechar o Hub.</div>`;
    $("#btnSelf").onclick = async () => { const r = await hub.selfRestart(); if (!r.ok) toast(r.error, "err"); };
  } else if (u.error) {
    box.innerHTML = `Não foi possível baixar o <b>Hub v${esc(u.version)}</b><button class="btn sm" id="btnSelf">Tentar de novo</button>`;
    $("#btnSelf").onclick = () => { box.dataset.k = ""; hub.selfCheck().then(load); };
  } else {
    box.innerHTML = `Baixando o <b>Hub v${esc(u.version)}</b>...<div class="progress" style="margin-top:8px"><i style="width:${Math.round((u.pct || 0) * 100)}%"></i></div>`;
  }
}

function visibleApps() {
  const q = $("#search").value.trim().toLowerCase();
  let list = snap.apps;
  if (view === "library") list = list.filter((a) => st(a).installed || jobs[a.id]);
  if (view === "updates") list = list.filter((a) => st(a).updateAvailable || (jobs[a.id] && st(a).installed));
  if (category !== "Todos") list = list.filter((a) => (a.category || "Outros") === category);
  if (q) list = list.filter((a) => (a.name + " " + (a.description || "") + " " + (a.category || "")).toLowerCase().includes(q));
  return list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function renderGrid() {
  const cats = ["Todos", ...new Set(snap.apps.map((a) => a.category || "Outros"))];
  if (!cats.includes(category)) category = "Todos";
  $("#chips").innerHTML = cats.length > 2 ? cats.map((c) => `<button class="chip ${c === category ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("") : "";

  const list = visibleApps();
  const content = $("#content");
  if (!list.length && view !== "explore") {
    content.innerHTML = view === "library"
      ? `<div class="empty"><div class="big">▦</div><p>Nenhum app instalado ainda.</p><button class="btn primary" data-goto="explore">Explorar apps</button></div>`
      : `<div class="empty"><div class="big">✓</div><p>Tudo em dia! Nenhuma atualização pendente.</p></div>`;
    return;
  }
  content.innerHTML = `<div class="grid">${list.map(cardHtml).join("")}${view === "explore" ? addCardHtml() : ""}</div>`;
}

function iconHtml(a) {
  return `<div class="app-icon">${a.iconUrl ? `<img src="${esc(a.iconUrl)}" alt="">` : esc(a.name[0])}</div>`;
}

function statusPill(a) {
  const s = st(a);
  if (!a.status) return `<span class="pill off">verificando...</span>`;
  if (s.updateAvailable) return `<span class="pill upd">v${esc(s.latest.version)} disponível</span>`;
  if (s.installed) return `<span class="pill ok">Instalado</span>`;
  if (s.latestError) return `<span class="pill err" title="${esc(s.latestError)}">indisponível</span>`;
  return `<span class="pill off">Não instalado</span>`;
}

function primaryButton(a, sm) {
  const s = st(a), cls = sm ? " sm" : "";
  switch (stateOf(a)) {
    case "busy": return jobs[a.id].phase === "download" ? `<button class="btn${cls}" data-act="cancel" data-id="${a.id}">Cancelar</button>` : `<button class="btn${cls}" disabled>Aguarde...</button>`;
    case "update": return `<button class="btn primary${cls}" data-act="update" data-id="${a.id}">Atualizar</button>`;
    case "installed": return `<button class="btn primary${cls}" data-act="launch" data-id="${a.id}">Abrir</button>`;
    case "loading": return `<button class="btn${cls}" disabled>...</button>`;
    default: return `<button class="btn primary${cls}" data-act="install" data-id="${a.id}" ${s.latest ? "" : "disabled"}>Instalar</button>`;
  }
}

function jobHtml(a) {
  const j = jobs[a.id];
  if (!j) return "";
  const pct = j.pct == null ? null : Math.round(j.pct * 100);
  return `<div class="job" data-job="${a.id}"><div class="progress ${pct == null ? "indet" : ""}"><i style="width:${pct ?? 0}%"></i></div>
    <div class="job-text"><span class="jt">${esc(j.text || "")}</span><span class="jp">${pct == null ? "" : pct + "%"}</span></div></div>`;
}

function cardHtml(a) {
  const s = st(a);
  const ver = s.installed
    ? `v<b>${esc(s.version || "?")}</b>${s.updateAvailable ? ` → <b>${esc(s.latest.version)}</b>` : ""}`
    : s.latest ? `Última: <b>v${esc(s.latest.version)}</b>` : "";
  return `<div class="card" data-open="${a.id}" style="--card-accent:${esc(a.accent || "#a855f7")}">
    <div class="card-head">${iconHtml(a)}<div><h3>${esc(a.name)}</h3><div class="cat">${esc(a.category || "Outros")}${a.origin === "custom" ? ` · <span class="pill custom">seu</span>` : ""}</div></div></div>
    <p class="desc">${esc(a.description || "")}</p>
    ${jobHtml(a)}
    <div class="card-foot"><div><div>${statusPill(a)}</div><div class="ver" style="margin-top:5px">${ver}</div></div>${primaryButton(a)}</div>
  </div>`;
}

function addCardHtml() {
  return `<div class="card add-card" data-add="1"><div><div class="plus">＋</div><div>Adicionar app</div><div class="muted" style="font-size:12px;margin-top:4px">De um repositório do GitHub ou de uma pasta</div></div></div>`;
}

// atualiza só a barra de progresso (sem redesenhar a tela inteira)
function updateJobUi(id) {
  const els = document.querySelectorAll(`[data-job="${id}"]`);
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
  // botão "Cancelar" só durante o download
  document.querySelectorAll(`.card[data-open="${id}"] .card-foot .btn, .drawer .actions .btn[data-main]`).forEach((b) => {
    const want = j.phase === "download" ? "cancel" : "";
    if ((b.dataset.act || "") !== want) b.outerHTML = primaryButton(app(id));
  });
}

// ------------------------------------------------------------------ painel de detalhes
function openDrawer(id) { drawerId = id; renderDrawer(); }
function closeDrawer() { drawerId = null; $("#drawer").hidden = true; }

async function renderDrawer() {
  const a = app(drawerId);
  if (!a) return closeDrawer();
  const s = st(a), d = $("#drawer");
  d.hidden = false;
  d.style.setProperty("--card-accent", a.accent || "#a855f7");
  const src = a.source.type === "github" ? `<a href="https://github.com/${esc(a.source.repo)}" target="_blank">${esc(a.source.repo)}</a>` : esc(a.source.path);
  const more = [];
  if (s.installed) {
    more.push(`<button class="btn" data-act="folder" data-id="${a.id}">📁 Abrir pasta</button>`);
    if (!s.updateAvailable && s.latest) more.push(`<button class="btn" data-act="install" data-id="${a.id}">Reinstalar</button>`);
    more.push(`<button class="btn danger" data-act="uninstall" data-id="${a.id}">Desinstalar</button>`);
  } else if (a.install.type === "portable") {
    more.push(`<button class="btn" data-act="locate" data-id="${a.id}" title="Já tem este app numa pasta? Aponte para ela">Já tenho instalado...</button>`);
  }
  if (s.latest && s.latest.page) more.push(`<a class="btn ghost" href="${esc(s.latest.page)}" target="_blank">Ver no GitHub ↗</a>`);
  if (a.origin === "custom") more.push(`<button class="btn danger" data-act="removeCustom" data-id="${a.id}">Remover do Hub</button>`);

  d.innerHTML = `<button class="btn ghost sm close" data-close="1">✕</button>
    <div class="card-head">${iconHtml(a)}<div><h2>${esc(a.name)}</h2><div class="muted">${esc(a.category || "Outros")}</div><div style="margin-top:6px">${statusPill(a)}</div></div></div>
    <p style="color:#cfc9ee">${esc(a.description || "")}</p>
    ${jobHtml(a)}
    <div class="actions"><span data-main>${primaryButton(a)}</span>${more.join("")}</div>
    ${s.latestError ? `<div class="error-box">Não foi possível consultar a versão mais recente: ${esc(s.latestError)}</div>` : ""}
    <dl class="kv">
      <dt>Instalada</dt><dd>${s.installed ? "v" + esc(s.version || "?") : "—"}</dd>
      <dt>Mais recente</dt><dd>${s.latest ? "v" + esc(s.latest.version) + (s.latest.publishedAt ? ` <span class="muted">· ${fmtDate(s.latest.publishedAt)}</span>` : "") : "—"}</dd>
      ${s.latest && s.latest.size ? `<dt>Download</dt><dd>${mb(s.latest.size)}</dd>` : ""}
      ${s.installed ? `<dt>Pasta</dt><dd>${esc(s.dir)}</dd><dt>Espaço em disco</dt><dd id="dsize">calculando...</dd>` : ""}
      <dt>Origem</dt><dd>${src}</dd>
      <dt>Tipo</dt><dd>${a.install.type === "portable" ? "Portátil (pasta)" : "Instalador"}${a.install.selfUpdating ? " · também se atualiza sozinho" : ""}</dd>
    </dl>
    ${s.latest && s.latest.notes ? `<div class="section-title">Novidades da v${esc(s.latest.version)}</div><div class="notes">${esc(s.latest.notes)}</div>` : ""}`;

  d.querySelectorAll("[data-main] .btn").forEach((b) => (b.dataset.main = "1"));
  if (s.installed) {
    const r = await hub.folderSize(a.id);
    const el = $("#dsize");
    if (el && r.ok) el.textContent = mb(r.data);
  }
}

// ------------------------------------------------------------------ configurações
function renderSettings() {
  const s = snap.settings;
  $("#content").innerHTML = `<div class="settings">
    <div class="set toggle"><div><h4>Piphin Hub v${esc(snap.hubVersion)}</h4><p>O Hub se atualiza sozinho: consulta o GitHub ao abrir e a cada hora, baixa a versão nova em segundo plano e pergunta se pode reiniciar.</p></div>
      <button class="btn" id="sSelf">Verificar agora</button></div>
    <div class="set"><h4>Pasta dos apps portáteis</h4><p>Onde o Hub instala apps que vêm em .zip (ex.: Piphin LLM). Apps com instalador próprio usam a pasta deles.</p>
      <div class="row"><input type="text" id="sLib" value="${esc(s.libraryDir)}"><button class="btn" id="sLibPick">Escolher...</button></div></div>
    <div class="set toggle"><div><h4>Atalho na Área de Trabalho</h4><p>Ao instalar um app portátil, cria também um atalho na Área de Trabalho (o do Menu Iniciar é sempre criado).</p></div>
      <label class="switch"><input type="checkbox" id="sDesk" ${s.desktopShortcuts ? "checked" : ""}><span></span></label></div>
    <div class="set toggle"><div><h4>Atalhos do Piphin Hub</h4><p>Cria (ou recria) os atalhos do próprio Hub na Área de Trabalho e no Menu Iniciar.</p></div>
      <button class="btn" id="sHubLnk">Criar atalhos</button></div>
    <div class="set toggle"><div><h4>Verificar atualizações ao abrir</h4><p>Consulta o GitHub ao abrir o Hub e a cada 6 horas enquanto ele estiver aberto.</p></div>
      <label class="switch"><input type="checkbox" id="sCheck" ${s.checkOnStart ? "checked" : ""}><span></span></label></div>
    <div class="set toggle"><div><h4>Atualizar automaticamente</h4><p>Instala as versões novas sozinho, sem perguntar. Apps abertos ficam para a próxima verificação.</p></div>
      <label class="switch"><input type="checkbox" id="sAuto" ${s.autoUpdate ? "checked" : ""}><span></span></label></div>
    <div class="set"><h4>Catálogo online</h4><p>Endereço do <code>catalog.json</code> com a lista de apps. Publicar um app novo nele faz o app aparecer no Hub de todos os PCs, sem atualizar o Hub.</p>
      <div class="row"><input type="text" id="sCat" value="${esc(s.catalogUrl)}"></div></div>
    <div class="set"><h4>Token do GitHub (opcional)</h4><p>Só é necessário para repositórios privados ou se o limite de consultas do GitHub (60 por hora) for atingido. Fica salvo só neste PC.</p>
      <div class="row"><input type="password" id="sTok" value="${esc(s.githubToken)}" placeholder="ghp_..." autocomplete="off"></div></div>
  </div>`;
  const save = async (patch) => { const r = await hub.setSettings(patch); if (!r.ok) toast(r.error, "err"); else { toast("Configuração salva", "ok"); load(); } };
  $("#sLib").onchange = (e) => save({ libraryDir: e.target.value.trim() });
  $("#sLibPick").onclick = async () => { const r = await hub.pickFolder("Pasta dos apps"); if (r.ok && r.data) save({ libraryDir: r.data }); };
  $("#sDesk").onchange = (e) => save({ desktopShortcuts: e.target.checked });
  $("#sSelf").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Verificando...";
    const r = await hub.selfCheck();
    e.target.disabled = false; e.target.textContent = "Verificar agora";
    if (!r.ok) toast(r.error, "err");
    else if (!r.data) toast("O Hub já está na versão mais recente", "ok");
    load();
  };
  $("#sHubLnk").onclick = async () => { const r = await hub.hubShortcuts(); toast(r.ok ? "Atalhos do Hub criados" : r.error, r.ok ? "ok" : "err"); };
  $("#sCheck").onchange = (e) => save({ checkOnStart: e.target.checked });
  $("#sAuto").onchange = (e) => save({ autoUpdate: e.target.checked });
  $("#sCat").onchange = (e) => save({ catalogUrl: e.target.value.trim() });
  $("#sTok").onchange = (e) => save({ githubToken: e.target.value.trim() });
}

// ------------------------------------------------------------------ adicionar app
function openAddForm() {
  const f = { sourceType: "github", installType: "portable" };
  const box = $("#modalBox");
  box.innerHTML = `<h3>Adicionar app</h3><p class="muted" style="font-size:12.5px">O Hub baixa a versão mais recente do Release do GitHub (ou da pasta) e cuida das atualizações.</p>
    <div class="form">
      <div class="two"><label>Nome<input type="text" id="fName" placeholder="AutoClick"></label><label>Categoria<input type="text" id="fCat" placeholder="Produtividade"></label></div>
      <label>Descrição<input type="text" id="fDesc" placeholder="O que o app faz"></label>
      <label>Origem<div class="seg" id="fSrc"><button data-v="github" class="on">Release do GitHub</button><button data-v="local">Pasta local</button></div></label>
      <label id="lRepo">Repositório<input type="text" id="fRepo" placeholder="Ruiso-Outside/AutoClick"></label>
      <label id="lLocal" hidden>Pasta com os arquivos (.zip/.exe)<div class="row"><input type="text" id="fLocal"><button class="btn" id="fLocalPick">...</button></div></label>
      <label>Tipo de pacote<div class="seg" id="fType"><button data-v="portable" class="on">.zip portátil</button><button data-v="installer">Instalador .exe</button></div></label>
      <div class="two"><label>Arquivo do Release (regex)<input type="text" id="fAsset" placeholder="win-x64\\.zip$"></label><label>Executável do app<input type="text" id="fExe" placeholder="AutoClick.exe"></label></div>
      <div class="two" id="lInst" hidden><label>Argumentos silenciosos<input type="text" id="fSilent" placeholder="/S"></label><label>Chave de desinstalação<input type="text" id="fKey" placeholder="(opcional)"></label></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="fCancel">Cancelar</button><button class="btn primary" id="fSave">Adicionar</button></div>`;
  const seg = (sel, key, after) => box.querySelectorAll(sel + " button").forEach((b) => (b.onclick = (e) => {
    e.preventDefault();
    f[key] = b.dataset.v;
    box.querySelectorAll(sel + " button").forEach((x) => x.classList.toggle("on", x === b));
    after();
  }));
  seg("#fSrc", "sourceType", () => { $("#lRepo").hidden = f.sourceType !== "github"; $("#lLocal").hidden = f.sourceType !== "local"; });
  seg("#fType", "installType", () => { $("#lInst").hidden = f.installType !== "installer"; });
  $("#fLocalPick").onclick = async (e) => { e.preventDefault(); const r = await hub.pickFolder(); if (r.ok && r.data) $("#fLocal").value = r.data; };
  $("#fCancel").onclick = closeModal;
  $("#fSave").onclick = async () => {
    const r = await hub.addCustom({ ...f, name: $("#fName").value, category: $("#fCat").value, description: $("#fDesc").value,
      repo: $("#fRepo").value, localPath: $("#fLocal").value, asset: $("#fAsset").value, exe: $("#fExe").value,
      silentArgs: $("#fSilent").value, uninstallKey: $("#fKey").value.trim() });
    if (!r.ok) return toast(r.error, "err");
    closeModal();
    toast("App adicionado", "ok");
    load();
  };
  $("#modal").hidden = false;
  $("#fName").focus();
}

// ------------------------------------------------------------------ modal e avisos
let modalResolve = null;
function confirmBox(title, html, okText = "Confirmar", danger = false) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $("#modalBox").innerHTML = `<h3>${esc(title)}</h3><p>${html}</p><div class="modal-actions">
      <button class="btn ghost" id="mNo">Cancelar</button><button class="btn ${danger ? "danger" : "primary"}" id="mYes">${esc(okText)}</button></div>`;
    $("#modal").hidden = false;
    $("#mNo").onclick = () => closeModal(false);
    $("#mYes").onclick = () => closeModal(true);
    $("#mYes").focus();
  });
}
function closeModal(v = false) {
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

// ------------------------------------------------------------------ eventos
document.addEventListener("click", (e) => {
  const link = e.target.closest("a[href^='https://']");
  if (link) { e.preventDefault(); hub.openUrl(link.href); return; }
  const btn = e.target.closest("[data-act]");
  if (btn) { e.stopPropagation(); act(btn.dataset.act, btn.dataset.id); return; }
  const nav = e.target.closest("[data-view]");
  if (nav) { view = nav.dataset.view; closeDrawer(); render(); return; }
  const go = e.target.closest("[data-goto]");
  if (go) { view = go.dataset.goto; render(); return; }
  const chip = e.target.closest("[data-cat]");
  if (chip) { category = chip.dataset.cat; render(); return; }
  if (e.target.closest("[data-add]")) return openAddForm();
  const card = e.target.closest("[data-open]");
  if (card) return openDrawer(card.dataset.open);
  if (e.target.closest("[data-close]")) return closeDrawer();
  if (e.target.id === "modal") closeModal(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!$("#modal").hidden) closeModal(false); else closeDrawer(); }
});
$("#search").addEventListener("input", render);
$("#btnCheck").onclick = async () => {
  const b = $("#btnCheck");
  b.disabled = true; b.textContent = "Verificando...";
  const r = await hub.refresh(true);
  b.disabled = false; b.textContent = "⟳ Verificar";
  if (!r.ok) toast(r.error, "err");
  await load();
  const n = snap.apps.filter((a) => st(a).updateAvailable).length;
  toast(n ? `${n} atualização(ões) disponível(is)` : "Tudo atualizado", n ? "" : "ok");
};
$("#btnUpdateAll").onclick = updateAll;

load();
