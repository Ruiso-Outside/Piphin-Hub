// Mídia: tudo que os módulos criaram ou baixaram, num lugar só (lib/library.js).
// Tocar e ver, "Abrir no ..." outro módulo, mostrar na pasta e arrastar para qualquer programa.
// Também a janela "Escolher da mídia" que os módulos abrem (ctx.host.library.pick) e os recentes do Início.
// Carrega antes do app.js (o Início já usa homeRecent); os ajudantes do app.js ($, esc, render...) só são usados depois.
const KIND = { audio: ["Áudio", "audio-lines"], video: ["Vídeo", "film"], image: ["Imagem", "image"] };
const MEDIA_FILTERS = [["all", "Tudo"], ["audio", "Música e áudio"], ["video", "Vídeos"], ["image", "Imagens"]];
// módulos que alimentam a Mídia (para a tela vazia sugerir)
const MEDIA_SOURCES = [["musica", "baixe músicas livres para usar em vídeos"], ["som", "crie músicas e efeitos sonoros"],
  ["captura", "tire prints e grave a tela"], ["foto", "edite imagens"], ["video", "edite vídeos"]];
const media = { items: [], loaded: false, kind: "all", by: "", query: "", openers: { audio: [], video: [], image: [] } };
const thumbCache = new Map();

const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/").split("/").map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join("/");
const dur = (s) => { if (s > 0 && s < 1) return (Math.max(0.1, Math.round(s * 10) / 10) + " s").replace(".", ","); s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
const ago = (d) => {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 3600) return `há ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) { const n = Math.round(s / 86400); return n === 1 ? "ontem" : `há ${n} dias`; }
  return fmtDate(d);
};
const mediaItem = (id) => media.items.find((x) => x.id === id);

async function loadMedia() {
  const [r, ...ops] = await Promise.all([hub.library({ limit: 3000 }), hub.openers("audio"), hub.openers("video"), hub.openers("image")]);
  if (!r.ok) return toast(r.error, "err");
  media.items = r.data;
  ["audio", "video", "image"].forEach((k, i) => (media.openers[k] = ops[i].ok ? ops[i].data : []));
  media.loaded = true;
}
hub.onLibraryChanged(async () => {
  if (view !== "media" && view !== "home") { media.loaded = false; return; }
  await loadMedia();
  if (view === "media" || view === "home") render();
});

function mediaList(kind = media.kind) {
  const q = norm(media.query);
  return media.items.filter((x) => (kind === "all" || x.kind === kind) && (!media.by || x.by === media.by)
    && (!q || q.split(/\s+/).every((w) => norm([x.title, x.sub, x.artist, x.album, x.game, x.byName, ...(x.tags || [])].join(" ")).includes(w))));
}

// cartão de um item (sel: modo de escolha, com marca de selecionado)
function mediaCard(x, { pick = false, selected = false } = {}) {
  const [label, ico] = KIND[x.kind];
  const info = [x.byName, x.sub || label, x.duration ? dur(x.duration) : x.width ? `${x.width}×${x.height}` : ""].filter(Boolean);
  const opens = pick ? [] : (media.openers[x.kind] || []).filter((o) => o.id !== x.by);
  return `<div class="m-card ${pick ? "pick" : ""} ${selected ? "sel" : ""}" data-mi="${esc(x.id)}" ${pick ? "" : 'draggable="true"'} title="${esc(x.path)}">
    <div class="m-thumb k-${x.kind}"><i class="i i-${ico} ph"></i><img alt="" hidden>
      ${x.duration ? `<span class="m-dur">${dur(x.duration)}</span>` : ""}
      ${pick ? `<span class="m-check"><i class="i i-check"></i></span>` : `<button class="m-play" data-mplay="${esc(x.id)}" title="${x.kind === "audio" ? "Tocar" : "Ver"}"><i class="i i-${x.kind === "image" ? "eye" : "play"}"></i></button>`}</div>
    <div class="m-body"><b>${esc(x.title)}</b>
      <span class="m-info">${x.artist ? esc(x.artist) + " · " : ""}${esc(info.join(" · "))}</span>
      <div class="m-tags">${x.game ? `<span class="badge"><i class="i i-gamepad-2"></i>${esc(x.game)}</span>` : ""}
        ${x.license ? `<span class="badge" title="${esc(x.credit || "")}">${esc(x.license)}</span>` : ""}
        ${x.videoOk === false ? `<span class="badge warn" title="A licença desta música não permite usar em vídeos">não usar em vídeo</span>` : ""}
        ${pick ? "" : `<span class="faint">${esc(ago(x.addedAt))}</span>`}</div></div>
    ${pick ? "" : `<div class="m-actions">${opens.map((o) => `<button class="btn sm" data-mopen="${esc(o.id)}" data-id="${esc(x.id)}" title="Abrir no ${esc(o.name)}"><i class="i i-square-arrow-out-up-right"></i>${esc(o.name.replace(/^Piphin /, ""))}</button>`).join("")}
      <span class="grow"></span><button class="btn sm icon ghost" data-mfolder="${esc(x.id)}" title="Mostrar na pasta"><i class="i i-folder-open"></i></button></div>`}
  </div>`;
}

// miniaturas só dos cartões que aparecem na tela
const thumbObs = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObs.unobserve(e.target);
    fillThumb(e.target);
  }
}, { rootMargin: "200px" });
async function fillThumb(card) {
  const id = card.dataset.mi;
  let url = thumbCache.get(id);
  if (url === undefined) { const r = await hub.libThumb(id); url = r.ok ? r.data : null; thumbCache.set(id, url); }
  const img = $(".m-thumb img", card);
  if (url && img) { img.src = url; img.hidden = false; card.querySelector(".m-thumb").classList.add("has"); }
}
function watchThumbs(root) { $$(".m-card[data-mi]", root).forEach((c) => (thumbCache.has(c.dataset.mi) ? fillThumb(c) : thumbObs.observe(c))); }

function renderMedia(main) {
  if (!media.loaded) { main.innerHTML = `<div class="p-page"><div class="p-empty"><div class="spin"></div></div></div>`; loadMedia().then(() => view === "media" && render()); return; }
  const focused = document.activeElement && document.activeElement.id === "mediaSearch";
  const list = mediaList();
  const sources = [...new Map(media.items.map((x) => [x.by, x.byName])).entries()].sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
  main.innerHTML = `<div class="p-page media-page">
    <div class="p-head"><div><h1>Mídia</h1><p>O que você criou e baixou nos módulos, num lugar só. Abra em outro módulo ou arraste para qualquer programa.</p></div>
      ${media.items.length ? `<div class="actions"><label class="search"><i class="i i-search"></i><input id="mediaSearch" type="search" placeholder="Buscar" value="${esc(media.query)}" style="width:220px"></label>
        ${sources.length > 1 ? `<select id="mediaBy"><option value="">Todos os módulos</option>${sources.map(([id, n]) => `<option value="${esc(id)}" ${media.by === id ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>` : ""}</div>` : ""}</div>
    ${media.items.length ? `<div class="chips" style="margin-bottom:18px">${MEDIA_FILTERS.map(([k, n]) => `<button class="chip ${media.kind === k ? "active" : ""}" data-mkind="${k}">${n}<span class="count">${mediaList(k).length}</span></button>`).join("")}</div>` : ""}
    ${list.length ? `<div class="m-grid">${list.slice(0, 600).map((x) => mediaCard(x)).join("")}</div>${list.length > 600 ? `<p class="faint" style="margin-top:14px">Mostrando 600 de ${list.length}. Use a busca para achar o resto.</p>` : ""}`
      : media.items.length ? `<div class="p-empty"><i class="i i-search"></i><h3>Nada encontrado</h3><span>Tente outro termo ou filtro.</span></div>` : mediaEmpty()}
  </div>`;
  watchThumbs(main);
  const inp = $("#mediaSearch");
  if (inp) { inp.oninput = (e) => { media.query = e.target.value; render(); }; if (focused) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
  const by = $("#mediaBy");
  if (by) by.onchange = (e) => { media.by = e.target.value; render(); };
}

function mediaEmpty() {
  const tiles = MEDIA_SOURCES.map(([id, what]) => {
    const a = app(id);
    if (!a) return "";
    const m = (snap.modules || []).find((x) => x.id === id);
    return `<div class="list-item">${iconOf(a, m) ? `<img src="${esc(iconOf(a, m))}" alt="">` : ""}<div class="t"><b>${esc(a.name)}</b><span>${esc(what)}</span></div>${primaryButton(a, true)}</div>`;
  }).join("");
  return `<div class="card flat media-empty"><div class="row" style="gap:14px;margin-bottom:6px"><i class="i i-images" style="font-size:28px;color:var(--p-accent-2)"></i>
    <div><b>Ainda não tem nada aqui</b><div class="muted" style="font-size:13px">As músicas que você baixar, os sons que criar, os prints, as gravações e as imagens e vídeos que exportar aparecem aqui sozinhos, prontos para usar em qualquer módulo.</div></div></div>
    ${tiles}</div>`;
}

// recentes no Início
function homeRecent() {
  if (!media.loaded) { loadMedia().then(() => view === "home" && media.items.length && render()); return ""; }
  const list = media.items.slice(0, 6);
  if (!list.length) return "";
  return `<div class="p-section row" style="justify-content:space-between"><span>Criado recentemente</span><a class="link" data-goto="media">Ver toda a mídia<i class="i i-arrow-right"></i></a></div>
    <div class="m-grid recent">${list.map((x) => mediaCard(x)).join("")}</div>`;
}

// ------------------------------------------------------------------ tocar e ver
function playMedia(id) {
  const x = mediaItem(id);
  if (!x) return;
  if (x.kind === "audio") {
    const p = $("#mPlayer"), a = $("audio", p);
    $("#mpTitle").textContent = x.title;
    $("#mpSub").textContent = [x.artist, x.byName].filter(Boolean).join(" · ");
    const t = thumbCache.get(id);
    $("#mpCover").innerHTML = t ? `<img src="${esc(t)}" alt="">` : `<i class="i i-audio-lines"></i>`;
    a.src = fileUrl(x.path);
    p.hidden = false;
    a.play().catch((e) => toast("Não foi possível tocar: " + e.message, "err"));
    return;
  }
  const box = $("#modalBox");
  box.classList.add("wide");
  box.innerHTML = `<div class="m-view">${x.kind === "video" ? `<video src="${esc(fileUrl(x.path))}" controls autoplay></video>` : `<img src="${esc(fileUrl(x.path))}" alt="">`}</div>
    <div class="row" style="margin-top:12px;gap:10px"><div class="grow"><b>${esc(x.title)}</b><div class="faint" style="font-size:12px">${esc(x.byName)}${x.width ? ` · ${x.width}×${x.height}` : ""}${x.size ? " · " + mb(x.size) : ""}</div></div>
      ${(media.openers[x.kind] || []).filter((o) => o.id !== x.by).map((o) => `<button class="btn sm" data-mopen="${esc(o.id)}" data-id="${esc(x.id)}"><i class="i i-square-arrow-out-up-right"></i>Abrir no ${esc(o.name)}</button>`).join("")}
      <button class="btn sm" data-mfolder="${esc(x.id)}"><i class="i i-folder-open"></i>Pasta</button><button class="btn sm ghost" id="mvClose">Fechar</button></div>`;
  modalResolve = () => { const v = $(".m-view video", box); if (v) v.pause(); box.classList.remove("wide"); };
  $("#mvClose").onclick = () => closeModal();
  showModal();
}
function stopMediaPlayer() { const p = $("#mPlayer"); if (!p.hidden) { $("audio", p).pause(); p.hidden = true; } }
document.getElementById("mpClose").onclick = stopMediaPlayer;

async function openMediaIn(target, id) {
  closeModal();
  stopMediaPlayer();
  const r = await hub.openIn(target, id);
  if (!r.ok) toast(r.error, "err");
}

// ------------------------------------------------------------------ "Escolher da mídia" (pedido de um módulo)
hub.onPick(async (req) => {
  if (!$("#modal").hidden) closeModal(false);
  if (!media.loaded) await loadMedia();
  const kinds = req.kinds.length ? req.kinds : ["audio", "video", "image"];
  const st_ = { kind: kinds.length > 1 ? "all" : kinds[0], query: "", sel: [] };
  const box = $("#modalBox");
  box.classList.add("wide");
  const list = () => { const q = norm(st_.query); return media.items.filter((x) => kinds.includes(x.kind) && (st_.kind === "all" || x.kind === st_.kind)
    && (!q || q.split(/\s+/).every((w) => norm([x.title, x.sub, x.artist, x.game, x.byName].join(" ")).includes(w)))); };
  const draw = () => {
    const l = list();
    $("#pkGrid").innerHTML = l.length ? l.slice(0, 400).map((x) => mediaCard(x, { pick: true, selected: st_.sel.includes(x.id) })).join("")
      : `<div class="p-empty" style="grid-column:1/-1"><i class="i i-images"></i><h3>${media.items.some((x) => kinds.includes(x.kind)) ? "Nada encontrado" : "Nada na Mídia ainda"}</h3>
         <span>${media.items.some((x) => kinds.includes(x.kind)) ? "Tente outro termo." : "O que você baixar e criar nos módulos aparece aqui."}</span></div>`;
    watchThumbs($("#pkGrid"));
    $("#pkOk").disabled = !st_.sel.length;
    $("#pkOk").innerHTML = `<i class="i i-check"></i>${st_.sel.length > 1 ? `Usar ${st_.sel.length} itens` : "Usar"}`;
  };
  box.innerHTML = `<div class="row" style="justify-content:space-between;gap:12px"><div><h3 style="margin:0">${esc(req.title || "Escolher da mídia")}</h3>
      <p style="font-size:13px;margin:4px 0 0">Para o ${esc(req.from)}. ${req.multi ? "Dá para escolher vários." : ""}</p></div>
      <label class="search"><i class="i i-search"></i><input id="pkSearch" type="search" placeholder="Buscar" style="width:200px"></label></div>
    ${kinds.length > 1 ? `<div class="chips" style="margin:14px 0 4px">${MEDIA_FILTERS.filter(([k]) => k === "all" || kinds.includes(k)).map(([k, n]) => `<button class="chip ${st_.kind === k ? "active" : ""}" data-pk="${k}">${n}</button>`).join("")}</div>` : ""}
    <div class="m-grid pick" id="pkGrid"></div>
    <div class="modal-actions"><button class="btn ghost" id="pkNo">Cancelar</button><button class="btn primary" id="pkOk" disabled>Usar</button></div>`;
  modalResolve = (ids) => { box.classList.remove("wide"); hub.pickDone(req.id, Array.isArray(ids) ? ids : []); };
  $("#pkSearch").oninput = (e) => { st_.query = e.target.value; draw(); };
  $$("[data-pk]", box).forEach((b) => (b.onclick = () => { st_.kind = b.dataset.pk; $$("[data-pk]", box).forEach((c) => c.classList.toggle("active", c === b)); draw(); }));
  $("#pkGrid").onclick = (e) => {
    const c = e.target.closest("[data-mi]");
    if (!c) return;
    const id = c.dataset.mi;
    if (!req.multi) st_.sel = [id];
    else st_.sel = st_.sel.includes(id) ? st_.sel.filter((x) => x !== id) : [...st_.sel, id];
    $$("#pkGrid [data-mi]").forEach((el) => el.classList.toggle("sel", st_.sel.includes(el.dataset.mi)));
    $("#pkOk").disabled = !st_.sel.length;
    $("#pkOk").innerHTML = `<i class="i i-check"></i>${st_.sel.length > 1 ? `Usar ${st_.sel.length} itens` : "Usar"}`;
  };
  $("#pkGrid").ondblclick = (e) => { const c = e.target.closest("[data-mi]"); if (c && !req.multi) closeModal([c.dataset.mi]); };
  $("#pkNo").onclick = () => closeModal(false);
  $("#pkOk").onclick = () => closeModal(st_.sel);
  showModal();
  draw();
  $("#pkSearch").focus();
});

// ------------------------------------------------------------------ eventos
document.addEventListener("click", (e) => {
  const k = e.target.closest("[data-mkind]");
  if (k) { media.kind = k.dataset.mkind; return render(); }
  const play = e.target.closest("[data-mplay]");
  if (play) { e.stopPropagation(); return playMedia(play.dataset.mplay); }
  const op = e.target.closest("[data-mopen]");
  if (op) { e.stopPropagation(); return openMediaIn(op.dataset.mopen, op.dataset.id); }
  const f = e.target.closest("[data-mfolder]");
  if (f) { e.stopPropagation(); return hub.showMedia(f.dataset.mfolder); }
  const card = e.target.closest(".m-card:not(.pick) .m-thumb");
  if (card) return playMedia(card.closest("[data-mi]").dataset.mi);
}, true);
// arrastar para fora: o Hub entrega o arquivo de verdade (Explorer, WhatsApp, Discord...)
document.addEventListener("dragstart", (e) => {
  const c = e.target.closest && e.target.closest(".m-card[draggable]");
  if (!c) return;
  e.preventDefault();
  hub.dragOut(c.dataset.mi);
});
