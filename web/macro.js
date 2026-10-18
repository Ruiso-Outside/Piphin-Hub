// Interface do Piphin Macro (aba "Macros" do Hub). Usa $, esc, toast e confirmBox do app.js.
const Macro = (() => {
  let ms = { macros: [], settings: {}, running: {}, pending: [], engine: {} };
  let tab = "macros";
  let sel = null;          // macro selecionada
  let draft = null;        // cópia em edição (salva sozinha)
  let saveTimer = null;
  let selStep = -1;        // passo selecionado (novos passos entram depois dele)
  let mounted = false;
  let recOpts = { moves: false, relative: false, mode: "append" };
  const loops = {};        // id -> { loops, t0, n0 } (contagem ao vivo)

  // ---------------------------------------------------------------- nomes das teclas
  const VK = { 1: "Mouse Esq.", 2: "Mouse Dir.", 4: "Mouse Meio", 5: "Mouse 4", 6: "Mouse 5", 8: "Backspace", 9: "Tab", 12: "Clear", 13: "Enter",
    16: "Shift", 17: "Ctrl", 18: "Alt", 19: "Pause", 20: "Caps Lock", 27: "Esc", 32: "Espaço", 33: "Page Up", 34: "Page Down", 35: "End", 36: "Home",
    37: "←", 38: "↑", 39: "→", 40: "↓", 44: "Print Screen", 45: "Insert", 46: "Delete", 91: "Win", 92: "Win Dir.", 93: "Menu",
    106: "Num *", 107: "Num +", 108: "Num Enter", 109: "Num -", 110: "Num ,", 111: "Num /", 144: "Num Lock", 145: "Scroll Lock",
    160: "Shift Esq.", 161: "Shift Dir.", 162: "Ctrl Esq.", 163: "Ctrl Dir.", 164: "Alt Esq.", 165: "Alt Gr",
    173: "Mudo", 174: "Volume -", 175: "Volume +", 176: "Próxima faixa", 177: "Faixa anterior", 178: "Parar mídia", 179: "Play/Pause",
    186: "Ç", 187: "=", 188: ",", 189: "-", 190: ".", 191: ";", 192: "'", 193: "/", 194: "Num .", 219: "´", 220: "]", 221: "[", 222: "~", 226: "\\" };
  for (let i = 48; i <= 57; i++) VK[i] = String.fromCharCode(i);
  for (let i = 65; i <= 90; i++) VK[i] = String.fromCharCode(i);
  for (let i = 96; i <= 105; i++) VK[i] = "Num " + (i - 96);
  for (let i = 112; i <= 135; i++) VK[i] = "F" + (i - 111);
  const keyName = (vk) => VK[vk] || (vk ? "Tecla " + vk : "—");
  const MODS = [[1, "Ctrl"], [2, "Alt"], [4, "Shift"], [8, "Win"]];
  const hkName = (h) => (h && h.vk ? MODS.filter(([b]) => (h.mods || 0) & b).map(([, n]) => n + " + ").join("") + keyName(h.vk) : "Sem atalho");
  const BTN = [[1, "Esquerdo"], [2, "Direito"], [4, "Meio"], [5, "Lateral 4"], [6, "Lateral 5"]];
  const MODES = { once: "Uma vez", repeat: "Repetir N vezes", toggle: "Liga / desliga", hold: "Enquanto segurar" };
  const CODE_VK = { ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163, AltLeft: 164, AltRight: 165, MetaLeft: 91, MetaRight: 92, NumpadEnter: 13 };
  const isMod = (vk) => [16, 17, 18, 91, 92, 160, 161, 162, 163, 164, 165].includes(vk);
  const uid = () => Math.random().toString(16).slice(2, 12);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sw = (id, on, attrs = "") => `<label class="switch"><input type="checkbox" ${id ? `id="${id}"` : ""} ${on ? "checked" : ""} ${attrs}><span></span></label>`;

  // ---------------------------------------------------------------- dados
  async function load() {
    const r = await macro.snapshot();
    if (!r.ok) return toast(r.error, "err");
    ms = r.data;
    const n = Object.keys(ms.running || {}).length + (ms.recording ? 1 : 0);
    $("#macroBadge").hidden = !n;
    $("#macroBadge").textContent = ms.recording ? "REC" : n;
    if (!mounted || !isVisible()) return;
    renderStatus();
    if (tab === "macros") { renderList(); renderEditorStatus(); renderRecBanner(); }
    if (tab === "clicker") renderClickerStatus();
    if (tab === "settings") renderEngineBox();
  }
  const isVisible = () => mounted && document.querySelector("#content [data-macro-root]");
  const byId = (id) => ms.macros.find((m) => m.id === id);
  const userMacros = () => ms.macros.filter((m) => m.kind !== "clicker" && !m.id.startsWith("__"));

  macro.onChanged(load);
  macro.onLoop((l) => { const x = loops[l.id] || (loops[l.id] = { t0: performance.now(), n0: l.loops }); x.loops = l.loops; if (l.loops === 1) { x.t0 = performance.now(); x.n0 = 1; } liveLoop(l.id); });
  macro.onNotice((n) => toast(n.text, n.kind === "panic" ? "" : "err"));
  macro.onRecorded((r) => {
    if (!r.steps.length) { toast("Nada foi gravado"); return load(); }
    const m = draft && byId(draft.id) ? draft : null;
    if (!m) return;
    m.steps = recOpts.mode === "replace" ? r.steps : m.steps.concat(r.steps);
    toast(`${r.steps.length} passo(s) gravado(s)`, "ok");
    queueSave(true);
    if (tab === "macros" && isVisible()) renderEditor();
  });
  macro.onInput((list) => Lab.push(list));

  // ---------------------------------------------------------------- casca
  function show() {
    if (isVisible()) return;
    mounted = true;
    $("#content").innerHTML = `<div data-macro-root class="mc">
      <div class="mc-status" id="mcStatus"></div>
      <div class="mc-tabs">
        ${[["macros", "⌨", "Macros"], ["clicker", "◉", "Autoclicker"], ["lab", "◬", "Analisador anti-macro"], ["settings", "⚙", "Ajustes"]]
          .map(([k, i, n]) => `<button class="mc-tab ${k === tab ? "on" : ""}" data-mtab="${k}"><span>${i}</span>${n}</button>`).join("")}
      </div>
      <div id="mcBody"></div>
    </div>`;
    renderStatus();
    renderTab();
    load();
  }

  function renderTab() {
    document.querySelectorAll("[data-mtab]").forEach((b) => b.classList.toggle("on", b.dataset.mtab === tab));
    if (tab !== "lab") Lab.stop();
    document.querySelector("main").scrollTop = 0;
    if (tab === "macros") renderMacros();
    else if (tab === "clicker") renderClicker();
    else if (tab === "lab") Lab.render();
    else renderSettings();
  }

  function renderStatus() {
    const box = $("#mcStatus");
    if (!box) return;
    const e = ms.engine || {};
    const running = Object.keys(ms.running || {}).length;
    const st = e.ready ? ["on", "Motor ativo"] : e.error ? ["err", "Motor com erro"] : e.running ? ["wait", "Iniciando motor..."] : ["off", "Motor parado (liga sozinho quando precisar)"];
    box.innerHTML = `<span class="mc-dot ${st[0]}"></span><span>${st[1]}</span>
      <span class="mc-sep"></span>
      <label class="mc-arm">${sw("mcArm", ms.settings.armed)}<span>Atalhos ${ms.settings.armed ? "ligados" : "desligados"}</span></label>
      <span class="mc-sep"></span>
      <span class="muted">Pânico: <kbd>${esc(hkName(ms.settings.panic))}</kbd></span>
      <span class="spacer"></span>
      ${running ? `<span class="mc-running">${running} em execução</span>` : ""}
      <button class="btn danger sm" id="mcStopAll" ${running || (ms.pending || []).length ? "" : "disabled"}>■ Parar tudo</button>`;
    $("#mcArm").onchange = (ev) => macro.settings({ armed: ev.target.checked });
    $("#mcStopAll").onclick = () => macro.stopAll();
  }

  // ---------------------------------------------------------------- lista + editor
  function renderMacros() {
    $("#mcBody").innerHTML = `<div class="mc-split">
      <aside class="mc-list">
        <div class="mc-list-actions">
          <button class="btn primary sm" id="mcNew">+ Nova macro</button>
          <button class="btn sm" id="mcTpl">Modelos ▾</button>
          <button class="btn ghost sm" id="mcImport" title="Importar de um arquivo .json">Importar</button>
        </div>
        <div id="mcItems"></div>
      </aside>
      <section class="mc-editor" id="mcEditor"></section>
    </div>`;
    $("#mcNew").onclick = () => create({ name: "Nova macro", steps: [] });
    $("#mcTpl").onclick = (e) => templateMenu(e.currentTarget);
    $("#mcImport").onclick = async () => { const r = await macro.importMacros(); if (!r.ok) toast(r.error, "err"); else if (r.data) { toast(`${r.data} macro(s) importada(s) (desligadas)`, "ok"); load(); } };
    if (!sel || !byId(sel) || byId(sel).kind === "clicker") sel = (userMacros()[0] || {}).id || null;
    selectMacro(sel);
    renderList();
  }

  function renderList() {
    const box = $("#mcItems");
    if (!box) return;
    const list = userMacros();
    if (!list.length) { box.innerHTML = `<div class="mc-empty">Nenhuma macro ainda.<br>Crie uma ou use um modelo.</div>`; return; }
    box.innerHTML = list.map((m0) => {
      const m = draft && draft.id === m0.id ? draft : m0;
      const run = ms.running[m.id], pend = (ms.pending || []).includes(m.id);
      return `<div class="mc-item ${m.id === sel ? "on" : ""} ${run ? "run" : ""} ${m.enabled ? "" : "off"}" data-msel="${m.id}">
        <div class="mc-item-top"><b>${esc(m.name)}</b>${run ? `<span class="mc-live">● ${run.loops ? "×" + run.loops : "rodando"}</span>` : pend ? `<span class="mc-live wait">contagem...</span>` : ""}</div>
        <div class="mc-item-sub"><kbd>${esc(hkName(m.hotkey))}</kbd><span>${esc(MODES[m.mode] || "")}</span><span>${(m.steps || []).length} passos</span></div>
      </div>`;
    }).join("");
  }

  async function create(def) {
    const m = { id: uid(), kind: "macro", enabled: true, hotkey: null, mode: "once", repeat: 5, jitter: 0, swallow: false, process: "", steps: [], ...clone(def) };
    const r = await macro.save(m);
    if (!r.ok) return toast(r.error, "err");
    ms.macros.push(r.data);
    sel = r.data.id;
    selectMacro(sel);
    renderList();
  }

  function selectMacro(id) {
    flushSave();
    sel = id;
    selStep = -1;
    draft = id && byId(id) ? clone(byId(id)) : null;
    renderEditor();
  }

  function queueSave(now) {
    if (!draft) return;
    const i = ms.macros.findIndex((m) => m.id === draft.id);
    if (i >= 0) ms.macros[i] = clone(draft);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, now ? 0 : 400);
    renderList();
  }
  function flushSave() {
    if (!saveTimer || !draft) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    macro.save(clone(draft)).then((r) => { if (!r.ok) toast(r.error, "err"); });
  }

  function renderEditor() {
    const box = $("#mcEditor");
    if (!box) return;
    if (!draft) { box.innerHTML = `<div class="mc-empty big"><div class="mc-glyph">⌨</div><p>Crie uma macro para começar.</p><p class="muted">Grave o que você faz no jogo ou monte passo a passo: teclas, cliques, movimentos, esperas, texto, cor de pixel e repetições.</p></div>`; return; }
    const m = draft;
    box.innerHTML = `
      <div class="mc-ed-head">
        <input type="text" class="mc-name" id="eName" value="${esc(m.name)}" spellcheck="false">
        <label class="mc-inline" title="Desligada: o atalho não dispara">${sw("eEnabled", m.enabled)}<span>Ativa</span></label>
        <div class="mc-ed-actions" id="eActions"></div>
      </div>
      <div class="mc-card mc-trigger">
        <div class="mc-field"><span>Atalho</span><button class="kbd-btn" id="eHotkey">${esc(hkName(m.hotkey))}</button></div>
        <div class="mc-field span2"><span>Modo</span><div class="seg" id="eMode">${Object.entries(MODES).map(([k, n]) => `<button data-v="${k}" class="${(m.mode || "once") === k ? "on" : ""}">${n}</button>`).join("")}</div></div>
        <div class="mc-field" id="eRepeatF" ${m.mode === "repeat" ? "" : "hidden"}><span>Vezes</span><input type="number" id="eRepeat" min="1" value="${m.repeat || 5}"></div>
        <div class="mc-field wide"><span>Variação humana <b id="eJitV">${m.jitter || 0}%</b></span><input type="range" id="eJit" min="0" max="50" value="${m.jitter || 0}">
          <small class="muted">Sorteia esperas, tempos segurados e curva do mouse. 0% = robótico (fácil de detectar).</small></div>
        <div class="mc-field"><span>Bloquear atalho no jogo</span>${sw("eSwallow", m.swallow)}</div>
        <div class="mc-field wide"><span>Só funciona no processo</span><div class="row"><input type="text" id="eProc" value="${esc(m.process || "")}" placeholder="qualquer janela (ex.: MeuJogo.exe, outro.exe)"><button class="btn sm" id="eProcCap" title="Pega o processo da janela em foco daqui a 3 segundos">Capturar janela</button></div></div>
      </div>
      <div class="mc-rec" id="eRec"></div>
      <div class="mc-steps-head">
        <h3>Passos <span class="muted" id="eCount"></span></h3>
        <div class="mc-add">
          ${[["key", "⌨ Tecla"], ["click", "🖱 Clique"], ["move", "↗ Mover"], ["wait", "⏱ Espera"], ["wheel", "⇕ Roda"], ["text", "T Texto"], ["pixel", "◉ Cor do pixel"], ["loop", "↻ Repetir bloco"]]
            .map(([t, n]) => `<button class="btn sm" data-add-step="${t}">${n}</button>`).join("")}
        </div>
      </div>
      <div class="mc-steps" id="eSteps"></div>`;

    $("#eName").oninput = (e) => { m.name = e.target.value; queueSave(); };
    $("#eEnabled").onchange = (e) => { m.enabled = e.target.checked; queueSave(true); };
    $("#eHotkey").onclick = async () => { const h = await captureKey({ hotkey: true }); if (h !== undefined) { m.hotkey = h; $("#eHotkey").textContent = hkName(h); queueSave(true); } };
    box.querySelectorAll("#eMode button").forEach((b) => (b.onclick = () => {
      m.mode = b.dataset.v;
      box.querySelectorAll("#eMode button").forEach((x) => x.classList.toggle("on", x === b));
      $("#eRepeatF").hidden = m.mode !== "repeat";
      queueSave(true);
    }));
    $("#eRepeat").oninput = (e) => { m.repeat = Math.max(1, +e.target.value || 1); queueSave(); };
    $("#eJit").oninput = (e) => { m.jitter = +e.target.value; $("#eJitV").textContent = m.jitter + "%"; queueSave(); };
    $("#eSwallow").onchange = (e) => { m.swallow = e.target.checked; queueSave(true); };
    $("#eProc").oninput = (e) => { m.process = e.target.value; queueSave(); };
    $("#eProcCap").onclick = async (e) => {
      const r = await countdown(e.currentTarget, 3, () => macro.capture("fg", 3));
      if (r && r.ok) { m.process = r.data.process + ".exe"; $("#eProc").value = m.process; queueSave(true); toast(`Processo: ${m.process}`, "ok"); }
    };
    box.querySelectorAll("[data-add-step]").forEach((b) => (b.onclick = () => addStep(b.dataset.addStep)));
    renderEditorStatus();
    renderRecBanner();
    renderSteps();
  }

  function renderEditorStatus() {
    const box = $("#eActions");
    if (!box || !draft) return;
    const run = ms.running[draft.id], pend = (ms.pending || []).includes(draft.id);
    const delay = ms.settings.testDelay ?? 3;
    box.innerHTML = `
      ${run ? `<button class="btn danger sm" id="eStop">■ Parar</button>`
        : `<button class="btn primary sm" id="eTest" title="Executa uma vez depois de ${delay}s (tempo para trocar para o jogo)">${pend ? "Cancelar contagem" : `▶ Testar (${delay}s)`}</button>`}
      <button class="btn ghost sm" id="eDup" title="Duplicar">⧉</button>
      <button class="btn ghost sm" id="eExp" title="Exportar para arquivo">⇪</button>
      <button class="btn ghost danger sm" id="eDel" title="Excluir">🗑</button>`;
    if (run) $("#eStop").onclick = () => macro.stop(draft.id);
    else $("#eTest").onclick = () => { flushSave(); macro.test(draft.id).then((r) => { if (!r.ok) toast(r.error, "err"); else if (r.data) toast(`Executando em ${delay}s... troque para o jogo`); }); };
    $("#eDup").onclick = () => create({ ...clone(draft), id: uid(), name: draft.name + " (cópia)", enabled: false });
    $("#eExp").onclick = () => { flushSave(); macro.exportMacros([draft.id]).then((r) => { if (r.ok && r.data) toast("Macro exportada", "ok"); }); };
    $("#eDel").onclick = async () => {
      if (!(await confirmBox(`Excluir "${draft.name}"?`, "A macro e todos os passos serão apagados.", "Excluir", true))) return;
      clearTimeout(saveTimer); saveTimer = null;
      const r = await macro.remove(draft.id);
      if (!r.ok) return toast(r.error, "err");
      ms.macros = ms.macros.filter((x) => x.id !== draft.id);
      sel = (userMacros()[0] || {}).id || null;
      selectMacro(sel);
      renderList();
    };
  }

  function renderRecBanner() {
    const box = $("#eRec");
    if (!box) return;
    const rec = ms.recording;
    if (rec) {
      box.className = "mc-rec on";
      box.innerHTML = `<span class="mc-rec-dot"></span><b>Gravando</b><span class="muted">${rec.count} evento(s) · pressione <kbd>${esc(hkName(ms.settings.record))}</kbd> no jogo para parar</span>
        <span class="spacer"></span><button class="btn danger sm" id="eRecStop">■ Parar gravação</button>`;
      $("#eRecStop").onclick = () => macro.recStop();
      return;
    }
    box.className = "mc-rec";
    box.innerHTML = `<button class="btn rec sm" id="eRecGo">● Gravar</button>
      <label class="mc-inline">${sw("eRecMv", recOpts.moves)}<span>Movimento do mouse</span></label>
      <label class="mc-inline" title="Para jogos em primeira pessoa: grava o deslocamento em vez da posição na tela">${sw("eRecRel", recOpts.relative)}<span>Relativo (câmera/FPS)</span></label>
      <div class="seg mini" id="eRecMode"><button data-v="append" class="${recOpts.mode === "append" ? "on" : ""}">Adicionar ao fim</button><button data-v="replace" class="${recOpts.mode === "replace" ? "on" : ""}">Substituir</button></div>
      <span class="muted mc-hint">Para parar: <kbd>${esc(hkName(ms.settings.record))}</kbd></span>`;
    $("#eRecMv").onchange = (e) => (recOpts.moves = e.target.checked);
    $("#eRecRel").onchange = (e) => (recOpts.relative = e.target.checked);
    box.querySelectorAll("#eRecMode button").forEach((b) => (b.onclick = () => { recOpts.mode = b.dataset.v; renderRecBanner(); }));
    $("#eRecGo").onclick = async () => {
      flushSave();
      const r = await macro.recStart({ moves: recOpts.moves, relative: recOpts.relative });
      if (!r.ok) toast(r.error, "err"); else toast(`Gravando... pressione ${hkName(ms.settings.record)} para parar`);
    };
  }

  // ---------------------------------------------------------------- passos
  const STEP_DEF = {
    key: () => ({ t: "key", vk: 69, act: "press", hold: 30 }),
    click: () => ({ t: "click", btn: 1, act: "click", hold: 25, count: 1 }),
    move: () => ({ t: "move", mode: "abs", x: 0, y: 0, dur: 150 }),
    wait: () => ({ t: "wait", ms: 100, max: 0 }),
    wheel: () => ({ t: "wheel", dir: "v", amount: -1 }),
    text: () => ({ t: "text", text: "", gap: 15 }),
    pixel: () => ({ t: "pixel", x: 0, y: 0, color: "ffffff", tol: 12, timeout: 0, not: false }),
    loop: () => ({ t: "loop", times: 3 }),
  };
  const ICON = { key: "⌨", click: "🖱", move: "↗", wait: "⏱", wheel: "⇕", text: "T", pixel: "◉", loop: "↻", end: "⤶" };

  function addStep(t) {
    const at = selStep >= 0 ? selStep + 1 : draft.steps.length;
    const add = t === "loop" ? [STEP_DEF.loop(), { t: "end" }] : [STEP_DEF[t]()];
    draft.steps.splice(at, 0, ...add);
    selStep = at;
    queueSave(true);
    renderSteps();
    const row = document.querySelector(`[data-step="${at}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  function renderSteps() {
    const box = $("#eSteps");
    if (!box) return;
    const steps = draft.steps;
    $("#eCount").textContent = steps.length ? `(${steps.length})` : "";
    if (!steps.length) { box.innerHTML = `<div class="mc-empty">Sem passos. Use <b>● Gravar</b> ou os botões acima.</div>`; return; }
    let depth = 0;
    const total = totalTime(steps);
    box.innerHTML = steps.map((s, i) => {
      if (s.t === "end") depth = Math.max(0, depth - 1);
      const html = `<div class="mc-step ${i === selStep ? "on" : ""} t-${s.t}" data-step="${i}" style="--d:${depth}">
        <span class="mc-n">${i + 1}</span><span class="mc-ico">${ICON[s.t] || "?"}</span>
        <div class="mc-step-body">${stepBody(s, i)}</div>
        <div class="mc-step-tools">
          <button data-sm="up" title="Subir">↑</button><button data-sm="down" title="Descer">↓</button>
          <button data-sm="dup" title="Duplicar">⧉</button><button data-sm="del" title="Remover">✕</button>
        </div></div>`;
      if (s.t === "loop") depth++;
      return html;
    }).join("") + `<div class="mc-steps-foot"><span class="muted">Duração estimada de uma execução: <b>${total}</b></span>
      <button class="btn ghost sm" id="eClear">Limpar passos</button></div>`;
    $("#eClear").onclick = async () => { if (await confirmBox("Limpar todos os passos?", "Os passos desta macro serão removidos.", "Limpar", true)) { draft.steps = []; selStep = -1; queueSave(true); renderSteps(); } };
  }

  function totalTime(steps) {
    let tot = 0;
    for (const s of steps) {
      if (s.t === "wait") tot += s.max > s.ms ? (s.ms + s.max) / 2 : +s.ms || 0;
      else if (s.t === "key" && s.act === "press") tot += +s.hold || 0;
      else if (s.t === "click" && s.act === "click") tot += (+s.hold || 0) * (2 * (s.count || 1) - 1);
      else if (s.t === "move") tot += +s.dur || 0;
      else if (s.t === "text") tot += (s.text || "").length * (+s.gap || 0);
    }
    const hasLoop = steps.some((s) => s.t === "loop");
    return (tot >= 1000 ? (tot / 1000).toFixed(2) + " s" : Math.round(tot) + " ms") + (hasLoop ? " (sem contar as repetições de bloco)" : "");
  }

  const num = (k, v, attrs = "") => `<input type="number" data-k="${k}" value="${esc(v ?? "")}" ${attrs}>`;
  const opt = (k, v, list) => `<select data-k="${k}">${list.map(([val, n]) => `<option value="${val}" ${String(val) === String(v) ? "selected" : ""}>${n}</option>`).join("")}</select>`;
  const lab = (t, html) => `<label class="mc-l"><span>${t}</span>${html}</label>`;

  function stepBody(s) {
    switch (s.t) {
      case "key": return `${lab("Tecla", `<button class="kbd-btn sm" data-kcap="vk">${esc(keyName(s.vk))}</button>`)}
        ${lab("Ação", opt("act", s.act, [["press", "Pressionar"], ["down", "Segurar (apertar)"], ["up", "Soltar"]]))}
        ${s.act === "press" ? lab("Segurar (ms)", num("hold", s.hold, 'min="0"')) : ""}`;
      case "click": return `${lab("Botão", opt("btn", s.btn, BTN))}
        ${lab("Ação", opt("act", s.act, [["click", "Clicar"], ["down", "Segurar (apertar)"], ["up", "Soltar"]]))}
        ${s.act === "click" ? lab("Segurar (ms)", num("hold", s.hold, 'min="0"')) + lab("Vezes", num("count", s.count || 1, 'min="1" max="100"')) : ""}`;
      case "move": return `${lab("Tipo", opt("mode", s.mode, [["abs", "Posição na tela"], ["rel", "Deslocar (relativo)"]]))}
        ${lab(s.mode === "rel" ? "ΔX" : "X", num("x", s.x))}${lab(s.mode === "rel" ? "ΔY" : "Y", num("y", s.y))}
        ${lab("Duração (ms)", num("dur", s.dur, 'min="0"'))}
        ${s.mode === "abs" ? `<button class="btn ghost sm cap" data-cap="pos" title="Posiciona o mouse e espera 3s">📍 Capturar</button>` : ""}`;
      case "wait": return `${lab("Esperar (ms)", num("ms", s.ms, 'min="0"'))}${lab("até (aleatório, opcional)", num("max", s.max || "", 'min="0" placeholder="—"'))}`;
      case "wheel": return `${lab("Direção", opt("dir", s.dir, [["v", "Vertical"], ["h", "Horizontal"]]))}${lab("Quantidade (+ cima / − baixo)", num("amount", s.amount, 'step="1"'))}`;
      case "text": return `${lab("Texto", `<textarea data-k="text" rows="1" spellcheck="false">${esc(s.text)}</textarea>`)}${lab("Intervalo (ms)", num("gap", s.gap, 'min="0"'))}`;
      case "pixel": return `${lab("X", num("x", s.x))}${lab("Y", num("y", s.y))}
        ${lab("Cor", `<span class="mc-color"><i style="background:#${esc(s.color)}"></i><input type="text" data-k="color" value="${esc(s.color)}" maxlength="6"></span>`)}
        ${lab("Tolerância", num("tol", s.tol, 'min="0" max="255"'))}
        ${lab("Esperar", opt("not", s.not ? 1 : 0, [[0, "ficar igual"], [1, "ficar diferente"]]))}
        ${lab("Limite (ms, 0 = sem)", num("timeout", s.timeout, 'min="0"'))}
        <button class="btn ghost sm cap" data-cap="pix" title="Aponte o mouse e espera 3s">📍 Capturar</button>`;
      case "loop": return `<b class="mc-loop">Repetir o bloco</b>${lab("Vezes (0 = sem fim)", num("times", s.times, 'min="0"'))}<span class="muted">até o "Fim da repetição"</span>`;
      case "end": return `<b class="mc-loop">Fim da repetição</b>`;
    }
    return "";
  }

  // edição dos passos (um ouvinte só para a lista inteira)
  document.addEventListener("input", (e) => {
    const row = e.target.closest("[data-step]");
    if (!row || !draft || !e.target.dataset.k) return;
    const s = draft.steps[+row.dataset.step];
    const k = e.target.dataset.k;
    let v = e.target.value;
    if (e.target.type === "number" || ["btn", "not"].includes(k)) v = v === "" ? 0 : +v;
    if (k === "not") v = !!v;
    if (k === "color") { v = v.replace(/[^0-9a-f]/gi, "").toLowerCase(); const i = row.querySelector(".mc-color i"); if (i && v.length === 6) i.style.background = "#" + v; }
    s[k] = v;
    queueSave();
    if (e.target.tagName === "SELECT") { row.querySelector(".mc-step-body").innerHTML = stepBody(s); }
    if (e.target.tagName === "TEXTAREA") { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }
  });

  document.addEventListener("click", async (e) => {
    const t = e.target;
    const mtab = t.closest("[data-mtab]");
    if (mtab) { flushSave(); tab = mtab.dataset.mtab; renderTab(); return; }
    const it = t.closest("[data-msel]");
    if (it) { if (it.dataset.msel !== sel) { selectMacro(it.dataset.msel); renderList(); } return; }
    const row = t.closest("[data-step]");
    if (!row || !draft) return;
    const i = +row.dataset.step;
    const tool = t.closest("[data-sm]");
    if (tool) {
      const st = draft.steps;
      const a = tool.dataset.sm;
      if (a === "up" && i > 0) { [st[i - 1], st[i]] = [st[i], st[i - 1]]; selStep = i - 1; }
      else if (a === "down" && i < st.length - 1) { [st[i + 1], st[i]] = [st[i], st[i + 1]]; selStep = i + 1; }
      else if (a === "dup") { st.splice(i + 1, 0, clone(st[i])); selStep = i + 1; }
      else if (a === "del") { st.splice(i, 1); selStep = Math.min(i, st.length - 1); }
      queueSave(true);
      renderSteps();
      return;
    }
    const kcap = t.closest("[data-kcap]");
    if (kcap) {
      const r = await captureKey({ hotkey: false });
      if (r !== undefined && r) { draft.steps[i].vk = r.vk; kcap.textContent = keyName(r.vk); queueSave(true); }
      return;
    }
    const cap = t.closest("[data-cap]");
    if (cap) {
      const r = await countdown(cap, 3, () => macro.capture("pix", 3));
      if (r && r.ok) {
        const s = draft.steps[i];
        s.x = r.data.x; s.y = r.data.y;
        if (cap.dataset.cap === "pix") s.color = r.data.color;
        row.querySelector(".mc-step-body").innerHTML = stepBody(s);
        queueSave(true);
        toast(`Capturado: ${r.data.x}, ${r.data.y}${cap.dataset.cap === "pix" ? " · #" + r.data.color : ""}`, "ok");
      }
      return;
    }
    if (selStep !== i) {
      selStep = i;
      document.querySelectorAll(".mc-step.on").forEach((x) => x.classList.remove("on"));
      row.classList.add("on");
    }
  });

  async function countdown(btn, secs, fn) {
    const old = btn.innerHTML;
    btn.disabled = true;
    let n = secs;
    btn.textContent = `${n}...`;
    const iv = setInterval(() => { n--; if (n > 0) btn.textContent = `${n}...`; }, 1000);
    try { return await fn(); }
    finally { clearInterval(iv); btn.innerHTML = old; btn.disabled = false; }
  }

  // ---------------------------------------------------------------- captura de tecla
  // Devolve { vk, mods } (Backspace = sem atalho -> null; Esc = cancelado -> undefined)
  function captureKey({ hotkey }) {
    return new Promise((resolve) => {
      macro.pause(true); // os atalhos não disparam enquanto escolhe
      const ov = document.createElement("div");
      ov.className = "mc-capture";
      ov.innerHTML = `<div class="mc-capture-box"><div class="mc-glyph">⌨</div>
        <h3>${hotkey ? "Pressione o atalho" : "Pressione a tecla"}</h3>
        <p class="muted">Teclado ou botão do mouse (meio e laterais${hotkey ? "; esquerdo/direito só com Ctrl/Alt/Shift" : ""}).</p>
        <div class="mc-capture-key" id="capKey">...</div>
        <p class="muted"><kbd>Esc</kbd> cancela${hotkey ? " · <kbd>Backspace</kbd> remove o atalho" : ""}</p></div>`;
      document.body.appendChild(ov);
      let pendingMod = null;
      const mods = (e) => (e.ctrlKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
      const done = (v) => {
        window.removeEventListener("keydown", kd, true); window.removeEventListener("keyup", ku, true);
        ov.removeEventListener("mousedown", md, true); ov.removeEventListener("contextmenu", stop, true);
        ov.remove();
        macro.pause(false);
        resolve(v);
      };
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      const kd = (e) => {
        stop(e);
        if (e.repeat) return;
        if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) return done(undefined);
        if (hotkey && e.key === "Backspace" && !mods(e)) return done(null);
        const vk = CODE_VK[e.code] || e.keyCode;
        if (isMod(vk) || [16, 17, 18].includes(e.keyCode)) { pendingMod = vk; $("#capKey").textContent = hkName({ vk, mods: 0 }) + " + ..."; return; }
        pendingMod = null;
        done({ vk, mods: hotkey ? mods(e) : 0 });
      };
      // só um modificador, sem outra tecla: vale ele mesmo
      const ku = (e) => { stop(e); if (pendingMod && (CODE_VK[e.code] || e.keyCode) === pendingMod) done({ vk: pendingMod, mods: 0 }); };
      const md = (e) => {
        stop(e);
        const vk = [1, 4, 2, 5, 6][e.button];
        if (!vk) return;
        if (hotkey && (vk === 1 || vk === 2) && !mods(e)) { $("#capKey").textContent = "Esquerdo/direito sozinhos atrapalham o jogo: use com Ctrl, Alt ou Shift"; return; }
        done({ vk, mods: hotkey ? mods(e) : 0 });
      };
      window.addEventListener("keydown", kd, true);
      window.addEventListener("keyup", ku, true);
      ov.addEventListener("mousedown", md, true);
      ov.addEventListener("contextmenu", stop, true);
    });
  }

  // ---------------------------------------------------------------- modelos
  const k = (vk, hold = 30) => ({ t: "key", vk, act: "press", hold });
  const w = (ms, max = 0) => ({ t: "wait", ms, max });
  const TEMPLATES = [
    { name: "Spam de tecla (turbo)", info: "Enquanto segurar o atalho, aperta E sem parar", mode: "hold", jitter: 15, hotkey: { vk: 5, mods: 0 }, steps: [k(69, 20), w(35, 55)] },
    { name: "Combo de habilidades", info: "1 → 2 → 3 com intervalo, uma vez por atalho", mode: "once", jitter: 10, hotkey: { vk: 118, mods: 0 }, steps: [k(49), w(120, 160), k(50), w(120, 160), k(51)] },
    { name: "Rajada de 3 cliques", info: "3 cliques rápidos no botão esquerdo", mode: "once", jitter: 10, hotkey: { vk: 6, mods: 0 }, steps: [{ t: "click", btn: 1, act: "click", hold: 30, count: 3 }] },
    { name: "Anti-AFK", info: "Anda para frente e para trás em intervalos aleatórios", mode: "toggle", jitter: 25, hotkey: { vk: 119, mods: 0 },
      steps: [k(87, 350), w(4000, 9000), k(83, 350), w(4000, 9000), { t: "click", btn: 2, act: "click", hold: 40, count: 1 }, w(2000, 5000)] },
    { name: "Reação a cor (teste de bot)", info: "Espera um pixel mudar de cor e clica: simula bot de reação", mode: "toggle", jitter: 0, hotkey: { vk: 118, mods: 4 },
      steps: [{ t: "pixel", x: 960, y: 540, color: "ff0000", tol: 30, timeout: 0, not: false }, { t: "click", btn: 1, act: "click", hold: 20, count: 1 }, w(300)] },
    { name: "Digitar mensagem no chat", info: "Enter, texto, Enter", mode: "once", jitter: 20, hotkey: { vk: 121, mods: 0 },
      steps: [k(13), w(150), { t: "text", text: "gg wp!", gap: 25 }, w(80), k(13)] },
    { name: "Farm em círculo", info: "Repete WASD em sequência com bloco de repetição", mode: "toggle", jitter: 20, hotkey: { vk: 122, mods: 0 },
      steps: [{ t: "loop", times: 4 }, { t: "key", vk: 87, act: "press", hold: 600 }, { t: "key", vk: 68, act: "press", hold: 600 }, { t: "key", vk: 83, act: "press", hold: 600 }, { t: "key", vk: 65, act: "press", hold: 600 }, { t: "end" }, k(32, 40), w(500)] },
  ];

  function templateMenu(anchor) {
    document.querySelectorAll(".mc-menu").forEach((x) => x.remove());
    const menu = document.createElement("div");
    menu.className = "mc-menu";
    menu.innerHTML = TEMPLATES.map((t, i) => `<button data-tpl="${i}"><b>${esc(t.name)}</b><span>${esc(t.info)} · <kbd>${esc(hkName(t.hotkey))}</kbd></span></button>`).join("");
    const r = anchor.getBoundingClientRect();
    menu.style.left = r.left + "px";
    menu.style.top = r.bottom + 6 + "px";
    document.body.appendChild(menu);
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("mousedown", close, true); } };
    setTimeout(() => document.addEventListener("mousedown", close, true));
    menu.onclick = (e) => {
      const b = e.target.closest("[data-tpl]");
      if (!b) return;
      const t = TEMPLATES[+b.dataset.tpl];
      menu.remove();
      document.removeEventListener("mousedown", close, true);
      create({ name: t.name, mode: t.mode, jitter: t.jitter, hotkey: t.hotkey, steps: clone(t.steps), repeat: 5 });
    };
  }

  // ---------------------------------------------------------------- autoclicker
  function clicker() { return ms.macros.find((m) => m.kind === "clicker"); }
  let clickDraft = null;

  function renderClicker() {
    const m0 = clicker();
    if (!m0) { $("#mcBody").innerHTML = `<div class="mc-empty">Carregando...</div>`; return; }
    clickDraft = clone(m0);
    const m = clickDraft, c = m.clicker;
    $("#mcBody").innerHTML = `<div class="mc-clicker">
      <div class="mc-card mc-power-card">
        <button class="mc-power" id="cPower" title="Liga/desliga agora (sem o atalho)"><span>⏻</span></button>
        <div class="mc-power-info">
          <div class="mc-big" id="cState">Desligado</div>
          <div class="muted" id="cLive">Use o atalho <kbd>${esc(hkName(m.hotkey))}</kbd> dentro do jogo</div>
        </div>
      </div>
      <div class="mc-card mc-grid2">
        <div class="mc-field"><span>Atalho</span><button class="kbd-btn" id="cHotkey">${esc(hkName(m.hotkey))}</button></div>
        <div class="mc-field"><span>Modo</span><div class="seg" id="cMode"><button data-v="toggle" class="${m.mode !== "hold" ? "on" : ""}">Liga / desliga</button><button data-v="hold" class="${m.mode === "hold" ? "on" : ""}">Enquanto segurar</button></div></div>
        <div class="mc-field"><span>Botão</span><div class="seg" id="cBtn">${BTN.slice(0, 3).map(([v, n]) => `<button data-v="${v}" class="${c.button === v ? "on" : ""}">${n}</button>`).join("")}</div></div>
        <div class="mc-field"><span>Ativo</span>${sw("cEnabled", m.enabled)}</div>
        <div class="mc-field wide"><span>Cliques por segundo: <b id="cCpsV">${c.cps}–${c.cpsMax}</b></span>
          <div class="mc-range2"><input type="range" id="cCps" min="1" max="50" step="0.5" value="${c.cps}"><input type="range" id="cCpsMax" min="1" max="50" step="0.5" value="${c.cpsMax}"></div>
          <small class="muted">Mínimo e máximo: cada intervalo é sorteado entre os dois (iguais = ritmo robótico).</small></div>
        <div class="mc-field"><span>Segurar cada clique (ms)</span><input type="number" id="cHold" min="1" max="500" value="${c.hold}"></div>
        <div class="mc-field"><span>Limite de ciclos (0 = sem limite)</span><input type="number" id="cLimit" min="0" value="${c.limit || 0}"></div>
        <div class="mc-field"><span>Clique duplo</span>${sw("cDouble", c.double)}</div>
        <div class="mc-field"><span>Bloquear atalho no jogo</span>${sw("cSwallow", m.swallow)}</div>
        <div class="mc-field wide"><span>Clicar sempre no mesmo ponto</span>
          <div class="row">${sw("cFixed", c.fixed)}<input type="number" id="cX" value="${c.x}" ${c.fixed ? "" : "disabled"}><input type="number" id="cY" value="${c.y}" ${c.fixed ? "" : "disabled"}><button class="btn sm" id="cCap">📍 Capturar (3s)</button></div></div>
        <div class="mc-field wide"><span>Só funciona no processo</span><div class="row"><input type="text" id="cProc" value="${esc(m.process || "")}" placeholder="qualquer janela"><button class="btn sm" id="cProcCap">Capturar janela</button></div></div>
      </div>
    </div>`;
    const save = (now) => { const i = ms.macros.findIndex((x) => x.id === m.id); ms.macros[i] = clone(m); clearTimeout(save.t); save.t = setTimeout(() => macro.save(clone(m)), now ? 0 : 300); };
    const seg = (sel, fn) => document.querySelectorAll(sel + " button").forEach((b) => (b.onclick = () => { document.querySelectorAll(sel + " button").forEach((x) => x.classList.toggle("on", x === b)); fn(b.dataset.v); save(true); }));
    seg("#cMode", (v) => (m.mode = v));
    seg("#cBtn", (v) => (c.button = +v));
    $("#cHotkey").onclick = async () => { const h = await captureKey({ hotkey: true }); if (h !== undefined) { m.hotkey = h; $("#cHotkey").textContent = hkName(h); save(true); renderClickerStatus(); } };
    $("#cEnabled").onchange = (e) => { m.enabled = e.target.checked; save(true); };
    const cps = () => {
      let a = +$("#cCps").value, b = +$("#cCpsMax").value;
      if (b < a) { if (document.activeElement === $("#cCps")) b = a; else a = b; $("#cCps").value = a; $("#cCpsMax").value = b; }
      c.cps = a; c.cpsMax = b; $("#cCpsV").textContent = a === b ? `${a}` : `${a}–${b}`; save();
    };
    $("#cCps").oninput = cps; $("#cCpsMax").oninput = cps;
    $("#cHold").oninput = (e) => { c.hold = Math.max(1, +e.target.value || 1); save(); };
    $("#cLimit").oninput = (e) => { c.limit = Math.max(0, +e.target.value || 0); save(); };
    $("#cDouble").onchange = (e) => { c.double = e.target.checked; save(true); };
    $("#cSwallow").onchange = (e) => { m.swallow = e.target.checked; save(true); };
    $("#cFixed").onchange = (e) => { c.fixed = e.target.checked; $("#cX").disabled = $("#cY").disabled = !c.fixed; save(true); };
    $("#cX").oninput = (e) => { c.x = +e.target.value; save(); };
    $("#cY").oninput = (e) => { c.y = +e.target.value; save(); };
    $("#cCap").onclick = async (e) => {
      const r = await countdown(e.currentTarget, 3, () => macro.capture("pix", 3));
      if (r && r.ok) { c.x = r.data.x; c.y = r.data.y; c.fixed = true; $("#cX").value = c.x; $("#cY").value = c.y; $("#cFixed").checked = true; $("#cX").disabled = $("#cY").disabled = false; save(true); }
    };
    $("#cProc").oninput = (e) => { m.process = e.target.value; save(); };
    $("#cProcCap").onclick = async (e) => {
      const r = await countdown(e.currentTarget, 3, () => macro.capture("fg", 3));
      if (r && r.ok) { m.process = r.data.process + ".exe"; $("#cProc").value = m.process; save(true); }
    };
    $("#cPower").onclick = async () => {
      if (ms.running[m.id]) return macro.stop(m.id);
      clearTimeout(save.t); await macro.save(clone(m));
      const delay = ms.settings.testDelay ?? 3;
      toast(`Autoclicker liga em ${delay}s... posicione o mouse`);
      setTimeout(async () => { const r = await macro.run(m.id).catch((x) => ({ ok: false, error: x.message })); if (!r.ok) toast(r.error, "err"); }, delay * 1000);
    };
    renderClickerStatus();
  }

  function renderClickerStatus() {
    const m = clickDraft;
    if (!m || !$("#cPower")) return;
    const run = ms.running[m.id];
    $("#cPower").classList.toggle("on", !!run);
    $("#cState").textContent = run ? "Clicando" : "Desligado";
    if (!run) $("#cLive").innerHTML = `Use o atalho <kbd>${esc(hkName(m.hotkey))}</kbd> dentro do jogo (${m.mode === "hold" ? "segure" : "aperte para ligar e de novo para desligar"})`;
  }

  function liveLoop(id) {
    if (tab === "clicker" && clickDraft && id === clickDraft.id && $("#cLive")) {
      const x = loops[id];
      const secs = (performance.now() - x.t0) / 1000;
      const per = clickDraft.clicker.double ? 2 : 1;
      const rate = secs > 0.3 ? ((x.loops - x.n0) * per / secs).toFixed(1) : "...";
      $("#cLive").innerHTML = `<b>${x.loops * per}</b> cliques · <b>${rate}</b> CPS real`;
    }
    const run = ms.running[id];
    if (run) { run.loops = loops[id].loops; const live = document.querySelector(`[data-msel="${id}"] .mc-live`); if (live) live.textContent = "● ×" + run.loops; }
  }

  // ---------------------------------------------------------------- ajustes
  function renderSettings() {
    const s = ms.settings;
    $("#mcBody").innerHTML = `<div class="settings">
      <div class="set toggle"><div><h4>Atalhos ligados</h4><p>Desligado, nenhum atalho de macro ou do autoclicker dispara (as teclas vão normalmente para o jogo).</p></div>${sw("sArmed", s.armed)}</div>
      <div class="set toggle"><div><h4>Tecla de pânico</h4><p>Para todas as macros na hora e solta qualquer tecla ou botão que estiver pressionado.</p></div><button class="kbd-btn" id="sPanic">${esc(hkName(s.panic))}</button></div>
      <div class="set toggle"><div><h4>Parar gravação</h4><p>Tecla usada dentro do jogo para encerrar a gravação de uma macro (não entra na gravação).</p></div><button class="kbd-btn" id="sRec">${esc(hkName(s.record))}</button></div>
      <div class="set toggle"><div><h4>Continuar na bandeja ao fechar</h4><p>Com atalhos ativos, fechar a janela do Hub mantém as macros funcionando (ícone perto do relógio). "Sair" no menu do ícone fecha de vez.</p></div>${sw("sTray", s.keepInTray)}</div>
      <div class="set toggle"><div><h4>Contagem do "Testar"</h4><p>Segundos de espera antes de executar pelo botão, para dar tempo de trocar para o jogo.</p></div><input type="number" id="sDelay" min="0" max="30" value="${s.testDelay ?? 3}" style="width:80px"></div>
      <div class="set" id="sEngine"></div>
      <div class="set mc-info"><h4>Segurança e como funciona</h4>
        <p>Nada é baixado nem instalado. O motor é o arquivo <code>lib\\macro\\engine.cs</code> dentro do Hub (código aberto, dá para ler): o próprio PowerShell do Windows o compila na memória ao ligar. Ele usa só funções do Windows: ganchos globais de teclado/mouse (<code>SetWindowsHookEx</code>) e <code>SendInput</code>.</p>
        <p>As teclas são enviadas por <b>scancode</b>, então funcionam também em jogos com DirectInput/Raw Input. Toda entrada enviada pelo Piphin é marcada e nunca dispara outro atalho.</p>
        <p><b>Jogo aberto como administrador?</b> O Windows bloqueia entradas de programas comuns nele: abra o Hub como administrador também.</p>
        <p>Use em jogos seus ou em modo offline: anti-cheats online (Vanguard, EAC, BattlEye...) detectam e banem macros.</p></div>
    </div>`;
    $("#sArmed").onchange = (e) => macro.settings({ armed: e.target.checked });
    $("#sTray").onchange = (e) => macro.settings({ keepInTray: e.target.checked });
    $("#sDelay").onchange = (e) => macro.settings({ testDelay: Math.max(0, Math.min(30, +e.target.value || 0)) });
    $("#sPanic").onclick = async () => { const h = await captureKey({ hotkey: true }); if (h !== undefined) { await macro.settings({ panic: h || { vk: 0, mods: 0 } }); $("#sPanic").textContent = hkName(h); } };
    $("#sRec").onclick = async () => { const h = await captureKey({ hotkey: true }); if (h) { await macro.settings({ record: h }); $("#sRec").textContent = hkName(h); } };
    renderEngineBox();
  }

  function renderEngineBox() {
    const box = $("#sEngine");
    if (!box) return;
    const e = ms.engine || {};
    box.innerHTML = `<div class="toggle"><div><h4>Motor de entrada</h4>
      <p>${e.ready ? `Ativo · tela virtual ${e.screen ? `${e.screen.w}×${e.screen.h}` : ""}` : e.error ? `<span style="color:var(--err)">${esc(e.error)}</span>` : e.running ? "Iniciando..." : "Parado. Ele liga sozinho quando algum atalho está ativo ou ao testar."}</p></div>
      <button class="btn" id="sEngStart" ${e.ready ? "disabled" : ""}>${e.ready ? "Ativo" : "Ligar agora"}</button></div>`;
    $("#sEngStart").onclick = async () => { const r = await macro.start(); if (!r.ok) toast(r.error, "err"); load(); };
  }

  load();
  return { show, load, isVisible, keyName, get tab() { return tab; } };
})();

// ------------------------------------------------------------------ analisador anti-macro
// Mostra cada entrada (física, injetada por outro programa, ou do próprio Piphin) e mede o ritmo:
// intervalos e tempos segurados muito constantes = robô.
const Lab = (() => {
  let on = false, moves = false;
  let events = [];          // últimos eventos (para o registro)
  let groups = {};          // "k65" / "m1" -> { name, downs:[t], holds:[ms], inj, ours, n, lastDown }
  let mv = { n: 0, teleports: 0, same: 0, last: null, lastD: null };
  let focus = null;         // grupo do histograma
  let raf = 0;
  const T0 = performance.now();

  const keyName = (e) => Macro.keyName(e.dev === "k" ? e.vk : e.btn);

  function reset() { events = []; groups = {}; mv = { n: 0, teleports: 0, same: 0, last: null, lastD: null }; focus = null; }

  function push(list) {
    if (!on) return;
    for (const e of list) {
      if (e.kind === "mv") {
        mv.n++;
        if (mv.last) {
          const dx = e.x - mv.last.x, dy = e.y - mv.last.y;
          if (Math.hypot(dx, dy) > 250) mv.teleports++;
          if (mv.lastD && dx === mv.lastD.dx && dy === mv.lastD.dy && (dx || dy)) mv.same++;
          mv.lastD = { dx, dy };
        }
        mv.last = { x: e.x, y: e.y };
        continue;
      }
      if (e.kind === "wh" || e.kind === "hw") { events.push(e); continue; }
      const key = e.dev + (e.dev === "k" ? e.vk : e.btn);
      const g = groups[key] || (groups[key] = { key, name: keyName(e), downs: [], holds: [], n: 0, inj: 0, ours: 0, lastDown: null, isDown: false });
      if (e.kind === "d") {
        if (g.isDown) continue; // repetição automática do teclado
        g.isDown = true;
        g.n++;
        if (e.src === 1) g.inj++;
        if (e.src === 2) g.ours++;
        g.downs.push(e.t);
        if (g.downs.length > 300) g.downs.shift();
        g.lastDown = e.t;
        if (!focus) focus = key;
      } else if (e.kind === "u") {
        g.isDown = false;
        if (g.lastDown != null) { g.holds.push(e.t - g.lastDown); if (g.holds.length > 300) g.holds.shift(); }
      }
      e.dt = g.downs.length > 1 && e.kind === "d" ? e.t - g.downs[g.downs.length - 2] : null;
      events.push(e);
    }
    if (events.length > 400) events = events.slice(-300);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

  // pontuação 0-100 com os motivos
  function analyze(g) {
    const iv = [];
    for (let i = 1; i < g.downs.length; i++) { const d = g.downs[i] - g.downs[i - 1]; if (d < 1500) iv.push(d); }
    const s = { n: g.n, iv, mean: mean(iv), sd: sd(iv), holdMean: mean(g.holds), holdSd: sd(g.holds), min: iv.length ? Math.min(...iv) : 0, reasons: [], score: 0 };
    s.cv = s.mean ? s.sd / s.mean : 0;
    s.cps = s.mean ? 1000 / s.mean : 0;
    const injPct = g.n ? (g.inj + g.ours) / g.n : 0;
    s.injPct = injPct;
    if (injPct > 0) { s.score += 60; s.reasons.push(`${Math.round(injPct * 100)}% das entradas têm a marca de injetada (LLKHF/LLMHF_INJECTED)`); }
    if (iv.length >= 8) {
      if (s.cv < 0.05) { s.score += 40; s.reasons.push(`Intervalos quase idênticos (variação ${(s.cv * 100).toFixed(1)}%; humanos ficam acima de ~10%)`); }
      else if (s.cv < 0.12) { s.score += 20; s.reasons.push(`Intervalos muito regulares (variação ${(s.cv * 100).toFixed(1)}%)`); }
      if (s.cps > 18) { s.score += 15; s.reasons.push(`Ritmo de ${s.cps.toFixed(1)} por segundo é difícil de manter à mão`); }
    }
    if (g.holds.length >= 8 && s.holdSd < 2) { s.score += 25; s.reasons.push(`Tempo segurado constante (desvio ${s.holdSd.toFixed(2)} ms)`); }
    if (g.holds.length >= 8 && s.holdMean < 8) { s.score += 10; s.reasons.push(`Soltura quase imediata (${s.holdMean.toFixed(1)} ms segurando)`); }
    s.score = Math.min(100, s.score);
    s.verdict = iv.length < 8 && !injPct ? ["off", "Poucos dados"] : s.score >= 60 ? ["err", "Macro / bot"] : s.score >= 30 ? ["upd", "Suspeito"] : ["ok", "Humano"];
    return s;
  }

  function render() {
    $("#mcBody").innerHTML = `<div class="mc-lab">
      <div class="mc-card mc-lab-bar">
        <button class="btn ${on ? "danger" : "primary"}" id="lOn">${on ? "■ Parar análise" : "▶ Iniciar análise"}</button>
        <label class="mc-inline">${`<label class="switch"><input type="checkbox" id="lMv" ${moves ? "checked" : ""}><span></span></label>`}<span>Analisar movimento do mouse</span></label>
        <button class="btn ghost sm" id="lClear">Limpar</button>
        <span class="spacer"></span>
        <span class="muted" title="Usa a tecla F24, que não faz nada no Windows">Simular:</span>
        <button class="btn sm" id="lBot">Macro robótica</button>
        <button class="btn sm" id="lHuman">Macro humanizada</button>
      </div>
      <div class="mc-lab-grid">
        <div class="mc-card"><h4 class="mc-h">Entradas analisadas</h4><div id="lGroups" class="mc-table-wrap"></div></div>
        <div class="mc-card"><h4 class="mc-h">Distribuição dos intervalos <span class="muted" id="lFocus"></span></h4><canvas id="lHist" height="170"></canvas><div id="lWhy" class="mc-why"></div></div>
        <div class="mc-card"><h4 class="mc-h">Eventos ao vivo</h4><div id="lLog" class="mc-log"></div></div>
        <div class="mc-card mc-tips"><h4 class="mc-h">Como detectar macros no seu jogo</h4>
          <ul>
            <li><b>Marca de injeção:</b> entradas criadas por <code>SendInput</code> chegam com <code>LLKHF_INJECTED</code>/<code>LLMHF_INJECTED</code> num gancho global. É o sinal mais barato (mas drivers de macro de hardware não deixam essa marca).</li>
            <li><b>Ritmo:</b> calcule o coeficiente de variação dos intervalos (desvio ÷ média). Humanos ficam acima de ~10%; macros sem variação ficam perto de 0%.</li>
            <li><b>Tempo segurado:</b> humanos seguram cada tecla/clique por tempos diferentes (40–120 ms). Desvio quase zero = robô.</li>
            <li><b>Distribuição:</b> macros "humanizadas" costumam sortear valores numa faixa uniforme (histograma achatado, com bordas duras). Humanos formam uma curva com cauda longa.</li>
            <li><b>Mouse:</b> teleportes, passos idênticos repetidos e linhas perfeitas indicam movimento sintético. Compare o Raw Input do jogo com o cursor: macro por <code>SendInput</code> absoluto não gera deltas de Raw Input iguais aos de um mouse real.</li>
            <li><b>Sessão longa:</b> ninguém mantém o mesmo ritmo por horas sem pausas; meça a fadiga e as pausas.</li>
          </ul></div>
      </div>
    </div>`;
    $("#lOn").onclick = () => (on ? stop() : start());
    $("#lMv").onchange = (e) => { moves = e.target.checked; if (on) macro.lab(true, moves); };
    $("#lClear").onclick = () => { reset(); draw(); };
    const sim = async (jitter) => {
      const id = "__lab_sim";
      if (!on) await start();
      await macro.save({ id, kind: "macro", name: "Simulação do analisador", enabled: false, mode: "repeat", repeat: 30, jitter, steps: [{ t: "key", vk: 135, act: "press", hold: 30 }, { t: "wait", ms: 70 }] });
      const r = await macro.run(id);
      if (!r.ok) toast(r.error, "err");
    };
    $("#lBot").onclick = () => sim(0);
    $("#lHuman").onclick = () => sim(40);
    draw();
  }

  async function start() {
    on = true;
    const r = await macro.lab(true, moves);
    if (!r.ok) { on = false; toast(r.error, "err"); }
    if ($("#lOn")) render();
  }
  function stop() {
    if (!on) return;
    on = false;
    macro.lab(false);
    if ($("#lOn")) { $("#lOn").className = "btn primary"; $("#lOn").textContent = "▶ Iniciar análise"; }
  }

  const SRC = [["ok", "Físico"], ["err", "Injetado"], ["custom", "Piphin"]];
  const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : "—");

  function draw() {
    const gBox = $("#lGroups");
    if (!gBox) return;
    const list = Object.values(groups).sort((a, b) => b.n - a.n).slice(0, 12);
    if (!list.length) gBox.innerHTML = `<div class="mc-empty">${on ? "Clique, aperte teclas ou rode uma macro: tudo aparece aqui." : "Inicie a análise e use o teclado/mouse (ou rode uma macro em outro jogo)."}</div>`;
    else {
      gBox.innerHTML = `<table class="mc-table"><thead><tr><th>Entrada</th><th>Qtd</th><th>Por seg.</th><th>Intervalo</th><th>Variação</th><th>Segurar</th><th>Injetado</th><th>Veredito</th></tr></thead><tbody>
        ${list.map((g) => { const s = analyze(g); return `<tr data-lg="${g.key}" class="${g.key === focus ? "on" : ""}"><td><b>${esc(g.name)}</b></td><td>${g.n}</td><td>${f1(s.cps)}</td>
          <td>${f1(s.mean)} ms <span class="muted">± ${f1(s.sd)}</span></td><td>${s.iv.length ? (s.cv * 100).toFixed(1) + "%" : "—"}</td>
          <td>${g.holds.length ? `${f1(s.holdMean)} <span class="muted">± ${f1(s.holdSd)}</span>` : "—"}</td><td>${Math.round(s.injPct * 100)}%</td>
          <td><span class="pill ${s.verdict[0]}">${s.verdict[1]}${s.verdict[0] === "off" ? "" : ` · ${s.score}`}</span></td></tr>`; }).join("")}
        </tbody></table>
        ${moves ? `<div class="mc-mv"><b>Mouse:</b> ${mv.n} movimentos · ${mv.teleports} teleporte(s) · ${mv.n ? Math.round((mv.same / mv.n) * 100) : 0}% passos idênticos seguidos ${mv.n > 50 && mv.same / mv.n > 0.3 ? `<span class="pill err">movimento sintético</span>` : ""}</div>` : ""}`;
      gBox.querySelectorAll("[data-lg]").forEach((tr) => (tr.onclick = () => { focus = tr.dataset.lg; draw(); }));
    }
    const log = $("#lLog");
    log.innerHTML = events.slice(-80).reverse().map((e) => {
      const src = SRC[e.src] || SRC[0];
      const what = e.dev === "k" ? (e.kind === "d" ? "↓ " : "↑ ") + keyName(e) : e.kind === "wh" || e.kind === "hw" ? `Roda ${e.delta > 0 ? "▲" : "▼"}` : (e.kind === "d" ? "↓ " : "↑ ") + keyName(e);
      return `<div class="mc-ev"><span class="muted">${((e.t || 0) / 1000).toFixed(3)}s</span><span>${esc(what)}</span><span class="muted">${e.dt != null ? "Δ " + e.dt.toFixed(1) + " ms" : ""}</span><span class="pill ${src[0]}">${src[1]}</span></div>`;
    }).join("") || `<div class="mc-empty">Nenhum evento ainda.</div>`;
    hist();
  }

  function hist() {
    const cv = $("#lHist");
    if (!cv) return;
    const g = groups[focus];
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 400, H = 170;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    $("#lFocus").textContent = g ? `· ${g.name}` : "";
    const why = $("#lWhy");
    if (!g) { why.innerHTML = ""; ctx.fillStyle = css.getPropertyValue("--muted"); ctx.font = "12px Segoe UI"; ctx.fillText("Sem dados", 12, 24); return; }
    const s = analyze(g);
    why.innerHTML = s.reasons.length ? s.reasons.map((r) => `<div>• ${esc(r)}</div>`).join("") : `<div class="muted">${s.iv.length < 8 ? "Precisa de pelo menos 9 eventos seguidos para medir o ritmo." : "Nenhum sinal de automação nesta entrada."}</div>`;
    if (!s.iv.length) return;
    const lo = Math.max(0, Math.min(...s.iv) - 5), hi = Math.max(...s.iv) + 5;
    const bins = Math.min(40, Math.max(10, Math.round((hi - lo) / 2)));
    const counts = new Array(bins).fill(0);
    for (const v of s.iv) counts[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins))]++;
    const max = Math.max(...counts);
    const pad = 22, bw = (W - 16) / bins;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#c084fc"); grad.addColorStop(1, "#7e22ce");
    ctx.shadowColor = "rgba(168,85,247,.7)"; ctx.shadowBlur = 10;
    ctx.fillStyle = grad;
    counts.forEach((c, i) => { const h = (c / max) * (H - pad - 10); ctx.fillRect(8 + i * bw + 1, H - pad - h, bw - 2, h); });
    ctx.shadowBlur = 0;
    ctx.fillStyle = css.getPropertyValue("--muted");
    ctx.font = "11px Segoe UI";
    ctx.fillText(`${lo.toFixed(0)} ms`, 8, H - 6);
    const t = `${hi.toFixed(0)} ms`;
    ctx.fillText(t, W - 8 - ctx.measureText(t).width, H - 6);
    const mid = `média ${s.mean.toFixed(1)} ms · ${s.iv.length} intervalos`;
    ctx.fillText(mid, W / 2 - ctx.measureText(mid).width / 2, H - 6);
  }

  window.addEventListener("resize", () => { if ($("#lHist")) hist(); });
  return { render, push, stop, get on() { return on; } };
})();
