'use strict';
/*
 * Apoio dos testes: roda js/app.js inteiro com DOM, câmera, voz e modelo SIMULADOS (stubs), sem navegador.
 * Opções novas (todas opcionais, compatíveis com os testes anteriores):
 *   gum(constraints)  substitui getUserMedia (ex.: promessa controlada ou erro com `name`);
 *   load(opts)        substitui cocoSsd.load (ex.: promessa controlada);
 *   semCocoSsd        simula a biblioteca que não carregou (sem internet);
 *   semVoz            navegador sem speechSynthesis;
 *   predsFn(i)        devolve as predições do i-ésimo detect (tem precedência sobre `script`);
 *   tfBackend         simula window.tf com esse backend ('webgl', 'cpu').
 * O objeto devolvido expõe contadores: trilhas abertas/paradas, getUserMedia chamados, cargas e dispose do modelo, e
 * `disparar(tipo, ev)` para eventos do documento (keydown, visibilitychange) e `fimCamera()` para simular a câmera perdida.
 */
const fs = require('fs'), path = require('path');
const RAIZ = path.join(__dirname, '..');
const SC = fs.readFileSync(path.join(RAIZ, 'js', 'app.js'), 'utf8');
const { criarNucleoVisio } = require(path.join(RAIZ, 'js', 'nucleo.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function montar({script = [[]], detectMs = 8, vals = {}, rvfcMs = null, loadMs = 0, loadFalha = false, detectFalha = false, facing = '', quadro = null,
                       gum = null, load = null, semCocoSsd = false, semVoz = false, predsFn = null, tfBackend = null} = {}){
  const v = Object.assign({conf: 60, persist: 2, intervalo: 20, cool: 30, modelo: 'lite_mobilenet_v2', camSel: '', passagem: 'desligada', modo: 'padrao', lados: 'normal'}, vals), els = {};
  const mk = id => els[id] || (els[id] = {id, value: v[id] ?? '', textContent: '', title: '', style: {}, dataset: {}, children: [], disabled: false, hidden: false, addEventListener(){}, prepend(){}, appendChild(){}, lastChild: {remove(){}},
    getContext: () => new Proxy({}, {get: (t, k) => k === 'measureText' ? () => ({width: 10}) : () => {}, set: () => true})});
  let api; const win = {}; const falas = []; let cancels = 0, i = 0, em = 0, maxEm = 0, calls = 0;
  const cont = {gum: 0, trilhas: 0, paradas: 0, cargas: 0, dispose: 0};
  const ss = {getVoices: () => [], speaking: false, speak: u => falas.push(u.t), cancel(){ cancels++; }};
  const docL = {};
  let fimCb = [];
  const novoStream = () => {
    cont.trilhas++;
    const trilha = {parada: false, stop(){ if (!this.parada){ this.parada = true; cont.paradas++; s.active = false; } }, addEventListener(t, f){ if (t === 'ended') fimCb.push(f); }, getSettings: () => facing ? ({facingMode: facing}) : ({})};
    const s = {active: true, getTracks: () => [trilha], getVideoTracks: () => [trilha]};
    return s;
  };
  const video = mk('video'); Object.assign(video, {readyState: 2, videoWidth: 640, videoHeight: 480, play: async () => {}});
  if (rvfcMs) video.requestVideoFrameCallback = cb => setTimeout(() => cb(performance.now(), {}), rvfcMs);
  const model = {dispose(){ cont.dispose++; }, detect: async () => { api.aoDetectar && api.aoDetectar(performance.now()); const k = i++; calls++; em++; maxEm = Math.max(maxEm, em);
    try { await sleep(detectMs); if (detectFalha) throw new Error('detect falhou'); return predsFn ? predsFn(k) : script[k % script.length]; } finally { em--; } }};
  const coco = semCocoSsd ? undefined : {load: async o => { cont.cargas++; if (load) return load(o, model); await sleep(loadMs); if (loadFalha) throw new Error('sem rede'); return Object.assign(Object.create(model), {base: o.base}); }};
  const navigator = {mediaDevices: {getUserMedia: async c => { cont.gum++; if (gum) { const r = await gum(c, novoStream); return r; } return novoStream(); }, enumerateDevices: async () => []}};
  const document = {getElementById: mk, createElement: tag => tag === 'canvas' ? {width: 0, height: 0, getContext: () => ({drawImage(){}, getImageData: () => quadro && quadro()})} : {},
    addEventListener(t, f){ (docL[t] = docL[t] || []).push(f); }, hidden: false};
  if (!semVoz) win.speechSynthesis = ss;
  win.VisioNucleo = criarNucleoVisio();
  if (tfBackend) win.tf = {getBackend: () => tfBackend};
  new Function('document', 'window', 'navigator', 'cocoSsd', 'speechSynthesis', 'SpeechSynthesisUtterance', SC)(
    document, win, navigator, coco, semVoz ? undefined : ss, class { constructor(t){ this.t = t; } });
  return api = {els, falas, ss, win, document, cont, calls: () => calls, maxEm: () => maxEm, cancels: () => cancels,
    estado: () => win.VisioIndustria.estadoSessao(),
    disparar: (tipo, ev = {}) => { for (const f of docL[tipo] || []) f(Object.assign({preventDefault(){ ev.prevenido = true; }}, ev)); return ev; },
    fimCamera: () => { const cbs = fimCb; fimCb = []; for (const f of cbs) f(); },
    iniciar: () => els.btnIniciar.onclick(), pausar: () => els.btnPausar.onclick(), encerrar: () => els.btnEncerrar.onclick()};
}
const d = (c, b, s = .8) => ({class: c, score: s, bbox: b});
// Promessa controlada pelo teste.
function adiada(){ let resolve, reject; const promessa = new Promise((a, b) => { resolve = a; reject = b; }); return {promessa, resolve, reject}; }
module.exports = {montar, d, sleep, adiada, criarNucleoVisio, SC};
