'use strict';
/*
 * Manifesto, ícones, service worker e coerência dos arquivos publicados. O service worker roda aqui num ambiente FALSO
 * (self, caches e fetch simulados): valida a lógica de cache, não o comportamento de um navegador real.
 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const RAIZ = path.join(__dirname, '..');
const ler = f => fs.readFileSync(path.join(RAIZ, f), 'utf8');
const HTML = ler('visioindustria.html');

const pngTamanho = f => { const b = fs.readFileSync(path.join(RAIZ, f)); assert.equal(b.toString('latin1', 1, 4), 'PNG', f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('manifesto: JSON válido, campos de instalação, ícones existentes com o tamanho declarado e sem prometer funcionamento offline', () => {
  const m = JSON.parse(ler('manifest.webmanifest'));
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color', 'icons']) assert.ok(m[k], k);
  assert.equal(m.lang, 'pt-BR'); assert.ok(fs.existsSync(path.join(RAIZ, m.start_url)), 'start_url inexistente');
  assert.ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512'));
  for (const i of m.icons){
    assert.ok(fs.existsSync(path.join(RAIZ, i.src)), i.src);
    if (i.type === 'image/png') assert.deepEqual(pngTamanho(i.src).join('x'), i.sizes, i.src);
  }
  assert.match(m.description, /internet/i); assert.doesNotMatch(m.description + m.name, /offline|sem internet/i);
});

test('HTML: todo arquivo local referenciado existe; nada de script ou estilo embutido (exigência da CSP)', () => {
  const refs = [...HTML.matchAll(/(?:src|href)="([^"#]+)"/g)].map(x => x[1]).filter(u => !/^https?:/.test(u));
  assert.ok(refs.length >= 6);
  for (const r of refs) assert.ok(fs.existsSync(path.join(RAIZ, r)), 'referência quebrada: ' + r);
  assert.doesNotMatch(HTML, /<script>|<style>|\sstyle="|\son[a-z]+="/i);
});

test('CSP: só as origens necessárias (mesma origem, jsDelivr para scripts, Google Storage para os pesos do modelo)', () => {
  const csp = HTML.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const dir = Object.fromEntries(csp.split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  // 'unsafe-eval' só porque o TensorFlow.js 4.22 usa Function() (sem ele a carga do modelo falha no Chromium; ver testes/navegador/verificar.js).
  assert.deepEqual(dir['script-src'], ["'self'", "'unsafe-eval'", 'https://cdn.jsdelivr.net']);
  assert.deepEqual(dir['connect-src'], ["'self'", 'https://storage.googleapis.com']);
  assert.deepEqual(dir['object-src'], ["'none'"]); assert.ok(!csp.includes('unsafe-inline')); assert.equal(csp.split('unsafe-eval').length, 2, 'unsafe-eval fora de script-src');
  // A URL padrão dos pesos no COCO-SSD 2.2.3 é https://storage.googleapis.com/tfjs-models/savedmodel/ (verificado no pacote publicado).
});

test('index.html redireciona para o aplicativo', () => {
  const h = ler('index.html'); assert.match(h, /url=visioindustria\.html/); assert.match(h, /href="visioindustria\.html"/);
});

// ---------- service worker em ambiente falso ----------
function ambienteSW({rede = true} = {}){
  const ouvintes = {}, caches = new Map(), log = [];
  const origem = 'https://exemplo.github.io', escopo = origem + '/vs_indus_22-10/';
  const resp = (url, ok = true) => ({ok, url, clone(){ return resp(url, ok); }});
  const cacheAPI = {
    open: async n => { if (!caches.has(n)) caches.set(n, new Map()); const c = caches.get(n);
      return {addAll: async us => { for (const u of us){ if (!rede) throw new Error('offline'); c.set(new URL(u, escopo).href, resp(u)); } }, put: async (req, r) => { c.set(req.url, r); }}; },
    keys: async () => [...caches.keys()],
    delete: async n => caches.delete(n),
    match: async req => { for (const c of caches.values()) if (c.has(req.url.split('?')[0])) return c.get(req.url.split('?')[0]); return undefined; }
  };
  const self = {location: {href: escopo + 'sw.js', origin: origem}, registration: {scope: escopo}, clients: {claim: async () => log.push('claim')}, skipWaiting: async () => log.push('skipWaiting'),
    addEventListener: (t, f) => { ouvintes[t] = f; }};
  const fetchFalso = async req => { log.push('rede ' + req.url); if (!ambiente.rede) throw new TypeError('Failed to fetch'); return resp(req.url); };
  const ambiente = {rede, self, caches, log, escopo, origem};
  new Function('self', 'caches', 'fetch', 'Response', 'URL', ler('sw.js'))(self, cacheAPI, fetchFalso, {error: () => ({erro: true})}, URL);
  ambiente.evento = async (tipo, extra = {}) => {
    let p = null; const esperas = [];
    const ev = Object.assign({waitUntil: x => esperas.push(x), respondWith: x => { p = x; }}, extra);
    ouvintes[tipo](ev); await Promise.all(esperas); return {respondeu: p !== null, resposta: p && await p, esperas: await Promise.all(esperas)};
  };
  ambiente.buscar = async (url, method = 'GET') => { const r = await ambiente.evento('fetch', {request: {url, method}}); await new Promise(s => setTimeout(s, 0)); return r; };
  return ambiente;
}
const VERSAO = ler('sw.js').match(/const VERSAO = '([^']+)'/)[1];
const CASCA = JSON.parse(ler('sw.js').match(/const CASCA = (\[[^\]]+\])/)[1].replace(/'/g, '"'));

test('service worker: a lista da casca corresponde a arquivos reais e inclui tudo que o HTML carrega da mesma origem', () => {
  for (const f of CASCA) assert.ok(fs.existsSync(path.join(RAIZ, f)), 'arquivo da casca inexistente: ' + f);
  const locais = [...HTML.matchAll(/(?:src|href)="([^"#]+)"/g)].map(x => x[1]).filter(u => !/^https?:/.test(u));
  for (const r of locais) assert.ok(CASCA.includes(r), 'não está na casca: ' + r);
  assert.ok(!CASCA.some(f => /tfjs|coco|model|\.bin$/.test(f)), 'modelo ou biblioteca na casca');
});

test('service worker: instala a casca na versão atual e, ao ativar, apaga só caches antigos DESTE app', async () => {
  const sw = ambienteSW();
  await sw.evento('install'); assert.ok(sw.caches.has(VERSAO)); assert.equal(sw.caches.get(VERSAO).size, CASCA.length); assert.ok(sw.log.includes('skipWaiting'));
  sw.caches.set('visioindustria-casca-v0', new Map()); sw.caches.set('outro-app', new Map());
  await sw.evento('activate');
  assert.deepEqual([...sw.caches.keys()].sort(), ['outro-app', VERSAO].sort()); assert.ok(sw.log.includes('claim'));
});

test('service worker: CDN, pesos do modelo, POST e arquivos fora da casca não são interceptados nem guardados', async () => {
  const sw = ambienteSW(); await sw.evento('install');
  for (const [u, m] of [['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js', 'GET'], ['https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/model.json', 'GET'],
                        [sw.escopo + 'js/app.js', 'POST'], [sw.escopo + 'qualquer-coisa.csv', 'GET']]){
    const r = await sw.buscar(u, m); assert.equal(r.respondeu, false, u + ' ' + m);
  }
  const total = [...sw.caches.values()].reduce((n, c) => n + c.size, 0); assert.equal(total, CASCA.length);
});

test('service worker: rede primeiro (versão publicada mais nova) e, sem rede, a casca guardada', async () => {
  const sw = ambienteSW(); await sw.evento('install');
  const r1 = await sw.buscar(sw.escopo + 'js/app.js'); assert.equal(r1.respondeu, true); assert.ok(sw.log.includes('rede ' + sw.escopo + 'js/app.js'));
  sw.rede = false;
  const r2 = await sw.buscar(sw.escopo + 'visioindustria.html?x=1'); assert.equal(r2.respondeu, true); assert.equal(r2.resposta.ok, true, 'sem fallback offline');
});

test('registro do service worker: só em contexto seguro; o código do app em si não usa armazenamento', () => {
  const pwa = ler('js/pwa.js'); assert.match(pwa, /isSecureContext/); assert.match(pwa, /register\('sw\.js'\)/);
  assert.doesNotMatch(ler('sw.js'), /localStorage|indexedDB|sendBeacon|postMessage/);
});
