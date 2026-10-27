'use strict';
/*
 * Verificação OPCIONAL num Chromium real (Playwright), fora do `npm test`. Usa a câmera FALSA do Chromium alimentada por um vídeo .y4m,
 * o TensorFlow.js e o COCO-SSD REAIS e os pesos REAIS do modelo, servidos de cópias locais (para rodar sem depender do CDN).
 * Valida: carregamento sem erro de CSP/SRI, ciclo iniciar → analisar → pausar → retomar → encerrar, liberação da câmera, falas,
 * service worker e abertura offline. NÃO valida celular, câmera física, voz real nem precisão em cena industrial.
 *
 * Preparação (uma vez), numa pasta qualquer ATIVOS:
 *   npm pack @tensorflow/tfjs@4.22.0 @tensorflow-models/coco-ssd@2.2.3  e extraia cada .tgz em ATIVOS/<nome do .tgz sem extensão>/
 *   baixe https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/{model.json,group1-shard1of5..5of5} em ATIVOS/modelo/ssdlite_mobilenet_v2/
 *   gere um vídeo: ffmpeg -loop 1 -i foto.jpg -vf "scale=640:-2,pad=640:480:0:(oh-ih)/2" -t 2 -r 15 -pix_fmt yuv420p ATIVOS/camera.y4m
 * Execução:  ATIVOS=/caminho node testes/navegador/verificar.js     (precisa do pacote playwright e de um Chromium instalado)
 */
const {chromium} = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const RAIZ = path.join(__dirname, '..', '..'), A = process.env.ATIVOS;
if (!A) { console.error('Defina ATIVOS (ver o comentário no topo).'); process.exit(2); }
const SAIDA = process.env.SAIDA || path.join(A, 'saida');
fs.mkdirSync(SAIDA, {recursive: true});
const TIPOS = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png'};

function servir(){
  return new Promise(ok => {
    const srv = http.createServer((req, res) => {
      const f = path.join(RAIZ, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); return res.end(); }
      res.writeHead(200, {'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache'}); fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => ok(srv));
  });
}
const ok = (cond, msg) => { console.log((cond ? 'OK   ' : 'FALHA') + ' ' + msg); if (!cond) process.exitCode = 1; };

(async () => {
  const srv = await servir(), base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(A, 'camera.y4m')]});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, permissions: ['camera']});
  let cdnAtivo = true;
  await ctx.route('https://cdn.jsdelivr.net/**', r => {
    if (!cdnAtivo) return r.abort('internetdisconnected');
    const u = r.request().url(), f = u.includes('tfjs@4.22.0') ? 'tensorflow-tfjs-4.22.0/package/dist/tf.min.js' : 'tensorflow-models-coco-ssd-2.2.3/package/dist/coco-ssd.min.js';
    r.fulfill({path: path.join(A, f), headers: {'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*'}});
  });
  await ctx.route('https://storage.googleapis.com/**', r => {
    const p = new URL(r.request().url()).pathname.replace('/tfjs-models/savedmodel/', '');
    r.fulfill({path: path.join(A, 'modelo', p), headers: {'Access-Control-Allow-Origin': '*'}});
  });
  // Registra o que seria falado (a voz do Chromium sem interface pode não ter vozes instaladas).
  await ctx.addInitScript(() => {
    window.__falas = []; window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    if (window.speechSynthesis){ const orig = speechSynthesis.speak.bind(speechSynthesis); speechSynthesis.speak = u => { window.__falas.push(u.text); try { orig(u); } catch (e) {} }; }
  });
  const page = await ctx.newPage(), erros = [];
  page.on('pageerror', e => erros.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  await page.goto(base + 'visioindustria.html');
  const txt = id => page.textContent('#' + id);
  ok(await page.isHidden('#avisoRede'), 'bibliotecas carregadas com SRI válido (aviso de rede oculto)');
  ok(await page.evaluate(() => typeof tf !== 'undefined' && typeof cocoSsd !== 'undefined' && !!window.VisioNucleo), 'tf, cocoSsd e núcleo disponíveis');
  await page.screenshot({path: path.join(SAIDA, '1-inicial-celular.png'), fullPage: false});

  await page.selectOption('#modelo', 'lite_mobilenet_v2'); await page.selectOption('#lados', 'normal');
  const t0 = Date.now(); await page.click('#btnIniciar');
  await page.waitForFunction(() => document.getElementById('estado').textContent.startsWith('Assistência ativa'), null, {timeout: 30000})
    .catch(async e => { console.log('     estado: ' + await txt('estado') + ' | status: ' + await txt('status') + ' | erros: ' + JSON.stringify(erros)); throw e; });
  console.log('     início até "ativa": ' + (Date.now() - t0) + ' ms (inclui carga do modelo local; não representa celular)');
  ok(await page.isDisabled('#modelo'), 'seletor de modelo travado durante a sessão');
  await page.waitForTimeout(6000);
  const painel = {};
  for (const id of ['mEst', 'mModelo', 'mBackend', 'mCarga', 'mInf', 'mCic', 'mFps', 'mCam', 'mFr', 'mErr', 'mUlt', 'oDec', 'oReg', 'oMot', 'status', 'estado']) painel[id] = (await txt(id)).trim();
  console.log('     painel: ' + JSON.stringify(painel, null, 1));
  ok(+painel.mFr > 5 && +painel.mErr === 0, 'ciclos concluídos sem erro');
  const falas = await page.evaluate(() => window.__falas);
  console.log('     falas: ' + JSON.stringify(falas));
  ok(falas.some(f => /Assistência ativada/.test(f)), 'fala de ativação');
  await page.click('details#diagnostico summary');
  await page.screenshot({path: path.join(SAIDA, '2-ativo-celular.png'), fullPage: true});

  await page.click('#btnPausar'); ok((await txt('btnPausar')) === 'Retomar' && (await txt('estado')) === 'Assistência pausada', 'pausa reflete na interface');
  const fr = +(await txt('mFr')); await page.waitForTimeout(1200); ok(+(await txt('mFr')) === fr, 'nenhum ciclo durante a pausa');
  await page.click('#btnPausar'); await page.waitForTimeout(1500); ok(+(await txt('mFr')) > fr, 'retomada volta a analisar');
  await page.click('#btnEncerrar');
  const cam = await page.evaluate(() => document.getElementById('video').srcObject === null);
  ok(cam && (await txt('estado')) === 'Pronta para iniciar', 'encerrar libera a câmera e volta ao repouso');
  const fr2 = +(await txt('mFr')); await page.waitForTimeout(1200); ok(+(await txt('mFr')) === fr2, 'nada roda depois de encerrar');

  // Teclado: Espaço inicia (modelo já carregado), Esc encerra.
  await page.focus('body'); await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('estado').textContent.startsWith('Assistência ativa'), null, {timeout: 30000});
  await page.keyboard.press('Escape'); ok((await txt('estado')) === 'Pronta para iniciar', 'atalhos Espaço/Esc');

  const csp = await page.evaluate(() => window.__csp);
  ok(csp.length === 0, 'nenhuma violação de CSP ' + JSON.stringify(csp));
  ok(erros.length === 0, 'nenhum erro de página/console ' + JSON.stringify(erros));

  // Service worker e abertura sem rede.
  const swOk = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(r => !!r.active), new Promise(r => setTimeout(() => r(false), 10000))]));
  ok(swOk, 'service worker ativo');
  await page.reload(); cdnAtivo = false; await ctx.setOffline(true);
  await page.reload();
  ok((await page.textContent('h1')) === 'VisioIndústria', 'casca abre sem rede (cache do service worker)');
  ok(await page.isVisible('#avisoRede'), 'sem rede: aviso de que a detecção não funciona offline');
  await page.click('#btnIniciar'); await page.waitForTimeout(1500);
  const st = await txt('status'); console.log('     status offline: ' + st);
  ok(/biblioteca de detecção/.test(st) && (await txt('estado')) === 'Modelo indisponível', 'offline: não finge que analisa');
  ok(await page.evaluate(() => document.getElementById('video').srcObject === null), 'offline: câmera liberada após a falha');
  await page.screenshot({path: path.join(SAIDA, '3-offline-celular.png')});
  await ctx.setOffline(false); cdnAtivo = true;

  // Largura de desktop.
  await page.setViewportSize({width: 1280, height: 900}); await page.reload(); await page.screenshot({path: path.join(SAIDA, '4-desktop.png'), fullPage: true});
  const transborda = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await page.setViewportSize({width: 320, height: 640}); await page.reload();
  ok(!transborda && !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'sem rolagem horizontal em 320 px e em 1280 px');
  await page.screenshot({path: path.join(SAIDA, '5-320px.png'), fullPage: true});
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
