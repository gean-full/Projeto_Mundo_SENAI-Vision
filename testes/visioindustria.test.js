'use strict';
/*
 * Testes automatizados do VisioIndústria (Node >= 21, sem dependências):   npm test   (ou: node --test 'testes/*.test.js')
 * A lógica pura vem de js/nucleo.js (require). Os testes "app" rodam js/app.js inteiro com câmera, voz e modelo SIMULADOS (stubs).
 * IMPORTANTE: os tempos e as detecções destes testes são sintéticos. Eles validam a LÓGICA (concorrência, contadores, erros, mensagens),
 * não a câmera real, a precisão do COCO-SSD nem o desempenho em celular.
 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const RAIZ = path.join(__dirname, '..');
const HTML = process.env.VISIO_HTML || path.join(RAIZ, 'visioindustria.html');
const SC = fs.readFileSync(path.join(RAIZ, 'js', 'app.js'), 'utf8');
const NUCLEO_SRC = fs.readFileSync(path.join(RAIZ, 'js', 'nucleo.js'), 'utf8');
const { criarNucleoVisio } = require(path.join(RAIZ, 'js', 'nucleo.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { criarAgendador } = criarNucleoVisio();
const P = criarNucleoVisio();

// ---------- agendador (unidade) ----------
// Relógio controlado: now() avança só quando a tarefa ou o agendador "gastam" tempo; timers reais com 0 ms.
function relogio(){ let t = 0; return {now: () => t, avanca: ms => { t += ms; }, setTimer: (f, ms) => { t += ms; return setTimeout(f, 0); }, clearTimer: clearTimeout, setWatch: (f, ms) => setTimeout(f, ms), clearWatch: clearTimeout}; }
const base = (r, extra = {}) => Object.assign({now: r.now, setTimer: r.setTimer, clearTimer: r.clearTimer, setWatch: r.setWatch, clearWatch: r.clearWatch, intervalo: () => 100, folgaMin: 30, folgaIgnorado: 20, stallMs: 1000, watchdogMs: 5000}, extra);
const ate = async (cond, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(2); assert.ok(cond(), 'condição não atingida a tempo'); };

test('agendador: mede inferência, ciclo total e FPS efetivo com relógio controlado', async () => {
  const r = relogio(), ag = criarAgendador(base(r));
  ag.registrar({nome: 'm', executar: async () => { r.avanca(50); return 1; }, aoConcluir: () => r.avanca(10)});
  ag.iniciar(); await ate(() => ag.snapshot().concluidos >= 40);
  const s = ag.snapshot(r.now()); ag.parar();
  assert.equal(s.tarefas.m.media, 50); assert.equal(s.tarefas.m.p95, 50);
  assert.equal(s.ciclo.media, 60);                                   // 50 inferência + 10 alertas/desenho
  assert.ok(s.fpsEfetivo > 9 && s.fpsEfetivo < 11, 'fps ' + s.fpsEfetivo); // período 60 + espera 40 = 100 ms → 10/s
  assert.equal(s.erros, 0); assert.equal(s.acimaIntervalo, 0);
});

test('agendador: duas tarefas nunca rodam ao mesmo tempo; cadaN reduz a frequência da segunda', async () => {
  let em = 0, max = 0, a = 0, b = 0;
  const gasta = async () => { em++; max = Math.max(max, em); await sleep(4); em--; };
  const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 10});
  ag.registrar({nome: 'a', prio: 1, executar: async () => { await gasta(); a++; }});
  ag.registrar({nome: 'b', prio: 2, cadaN: 3, executar: async () => { await gasta(); b++; }});
  ag.iniciar(); await ate(() => a >= 30, 8000); ag.parar();
  assert.equal(max, 1); assert.ok(Math.abs(b - a / 3) <= 1.5, `a=${a} b=${b}`);   // cadaN=3 é por número de ciclo: independe da velocidade da máquina
});

test('agendador: pausar/retomar repetidos não duplicam a cadeia nem a concorrência', async () => {
  let em = 0, max = 0, calls = 0; const inicios = [];
  const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 40});
  ag.registrar({nome: 'm', executar: async () => { inicios.push(performance.now()); em++; max = Math.max(max, em); calls++; await sleep(15); em--; }});
  ag.iniciar(); await sleep(250); let c0 = calls; await sleep(600); const antes = calls - c0;
  for (let i = 0; i < 60; i++){ ag.pausar(); await sleep(Math.random() * 30); ag.retomar(); await sleep(Math.random() * 30); }
  await sleep(300); c0 = calls; const i0 = inicios.length; await sleep(600); const depois = calls - c0; ag.parar();
  assert.equal(max, 1); assert.ok(depois <= antes * 1.25 + 1, `antes=${antes} depois=${depois}`);
  // com UMA cadeia, o espaçamento entre inícios nunca fica abaixo do intervalo (40 ms); cadeia duplicada o viola
  const esp = inicios.slice(i0).map((t, k, a) => k ? t - a[k-1] : Infinity).slice(1);
  assert.ok(Math.min(...esp) >= 36, 'espaçamento mínimo ' + Math.min(...esp).toFixed(1) + ' ms');
});

test('agendador: resultado obsoleto (pausa durante a inferência) é descartado', async () => {
  let concluiu = 0; const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 20});
  ag.registrar({nome: 'm', executar: async () => { await sleep(80); return 1; }, aoConcluir: () => concluiu++});
  ag.iniciar(); await sleep(30); ag.pausar(); await sleep(150);
  assert.equal(concluiu, 0); assert.equal(ag.snapshot().descartados, 1); assert.equal(ag.snapshot().concluidos, 0); ag.parar();
});

test('agendador: erro na tarefa ou em aoConcluir é contado e não prende o agendador', async () => {
  const r = relogio(); let falhas = 0, erros = [], k = 0;
  const ag = criarAgendador(base(r, {aoErro: e => erros.push(e.message)}));
  ag.registrar({nome: 'm', executar: async () => { if (++k <= 3) throw new Error('boom ' + k); return k; }, aoConcluir: v => { if (v === 5) throw new Error('falha no callback'); }});
  ag.iniciar(); await ate(() => ag.snapshot().concluidos >= 5);
  const s = ag.snapshot(); ag.parar();
  assert.equal(s.erros, 4); assert.deepEqual(erros.slice(0, 3), ['boom 1', 'boom 2', 'boom 3']); assert.equal(erros[3], 'falha no callback');
});

test('agendador: sem quadro novo → ciclo ignorado; passando de stallMs vira erro; recupera quando o quadro volta', async () => {
  const r = relogio(); let semQuadro = true, rodou = 0, erros = [];
  const ag = criarAgendador(base(r, {verificar: () => semQuadro ? {ignorar: 'sem_quadro_novo'} : {}, aoErro: e => erros.push(e.message)}));
  ag.registrar({nome: 'm', executar: async () => { rodou++; r.avanca(5); }});
  ag.iniciar(); await ate(() => erros.length >= 2);
  assert.equal(rodou, 0); assert.ok(ag.snapshot().motivos.sem_quadro_novo > 10); assert.match(erros[0], /Sem quadros novos/);
  semQuadro = false; await ate(() => ag.snapshot().concluidos >= 3); ag.parar();
  assert.ok(rodou >= 3);
});

test('agendador: aparelho lento não acumula trabalho; opcional é adiada', async () => {
  const r = relogio(); let opc = 0;
  const ag = criarAgendador(base(r, {intervalo: () => 20}));
  ag.registrar({nome: 'm', prio: 1, executar: async () => { r.avanca(60); }});
  ag.registrar({nome: 'x', prio: 2, opcional: true, executar: async () => { opc++; }});
  ag.iniciar(); await ate(() => ag.snapshot().concluidos >= 10); const s = ag.snapshot(); ag.parar();
  assert.equal(opc, 1);                                              // só no 1º ciclo, antes de o ciclo lento ser medido
  assert.ok(s.tarefas.x.adiadas >= 8); assert.equal(s.acimaIntervalo, s.concluidos);
});

test('agendador: watchdog abandona inferência travada e recomeça', async () => {
  let k = 0, erros = [], ok = 0;
  const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 20, watchdogMs: 80, aoErro: e => erros.push(e.message)});
  ag.registrar({nome: 'm', executar: () => ++k === 1 ? new Promise(() => {}) : Promise.resolve(1), aoConcluir: () => ok++});
  ag.iniciar(); await ate(() => ok >= 3, 1500); ag.parar();
  assert.equal(erros.length, 1); assert.match(erros[0], /travada/);
});

// ---------- planejador / estabilização (lógica pura) ----------
const grupo = (cls, z, n, area) => ({cls, info: P.CLASSES[cls], z, n, area});
test('planejador: mensagens e proibição de afirmar passagem livre', () => {
  const W = 640, H = 480, B = (cx, w, h) => [cx*W - w*W/2, 100, w*W, h*H];
  const g = (cls, cx, w, h, n = 1) => { const b = B(cx, w, h); return {cls, info: P.CLASSES[cls], z: P.zonaDe(b, W), n, area: b[2]*b[3]/(W*H)}; };
  const dizer = gs => P.planejar(gs).texto;
  assert.equal(dizer([g('chair', .15, .2, .3)]), 'Cadeira à esquerda.');
  assert.equal(dizer([g('person', .85, .15, .5), g('chair', .15, .2, .3)]), 'Pessoa à direita e cadeira à esquerda. Não foi possível confirmar uma passagem.');
  assert.equal(dizer([g('dining table', .2, .2, .2), g('chair', .15, .15, .3)]), 'Cadeira e mesa à esquerda.');
  assert.equal(dizer([g('person', .5, .15, .5), g('chair', .15, .2, .3)]), 'Pessoa à frente e cadeira à esquerda. Não foi possível confirmar uma passagem.');
  assert.match(dizer([g('dining table', .5, .9, .6)]), /^Mesa à frente\. Não foi possível confirmar uma passagem\.$/);
  for (const t of [dizer([g('person', .5, .2, .6), g('chair', .5, .3, .3)]), dizer([g('person', .5, .15, .5), g('chair', .15, .15, .3, 2), g('dining table', .85, .2, .2), g('bicycle', .9, .1, .2), g('backpack', .3, .05, .05)])]){
    assert.doesNotMatch(t, /caminho (seguro|livre)|pode seguir/i); assert.doesNotMatch(t, /passagem livre/i);
  }
});
test('estabilização: tolera 1 ciclo perdido, desativa após 3 ausências e não oscila a contagem', () => {
  const tr = new Map(), em = (n) => new Map(n ? [['cadeira|esquerda', grupo('chair', 'esquerda', n, .05)]] : []);
  const passo = (n) => P.atualizarTracks(tr, em(n), 2);
  assert.equal(passo(1).length, 0);                                  // 1ª presença: ainda não é estável (persist = 2)
  assert.equal(passo(1).length, 1);                                  // 2ª presença: ativa
  assert.equal(passo(0).length, 1); assert.equal(passo(0).length, 1); // 1 e 2 ausências: continua ativa
  assert.equal(passo(0).length, 0);                                  // 3ª ausência: desativa
  const tr2 = new Map(); const p2 = n => P.atualizarTracks(tr2, em(n), 2);
  p2(1); p2(1); const lidas = []; for (let i = 0; i < 12; i++) lidas.push(p2(i % 2 ? 2 : 1)[0].n);
  assert.ok(new Set(lidas).size === 1, 'contagem oscilou: ' + lidas);
});

// ---------- script completo com stubs ----------
const { montar, d } = require('./apoio.js');   // monta js/app.js com câmera, voz e modelo simulados

test('app: painel mostra métricas medidas, FPS da câmera (rVFC) e para tudo ao encerrar', async () => {
  const a = await montar({rvfcMs: 33, detectMs: 12}); assert.match(a.els.mModelo.textContent, /não carregado/);
  try {
    await a.iniciar(); await sleep(1800); a.els.btnIniciar.onclick && 0;
    const e = a.els; assert.match(e.mModelo.textContent, /^pronto/); assert.match(e.mCarga.textContent, /s$/);
    assert.match(e.mInf.textContent, /ms · méd .* · p95/); assert.match(e.mCic.textContent, /ms/); assert.match(e.mFps.textContent, /\/s$/);
    assert.match(e.mCam.textContent, /\/s$/); assert.ok(+e.mFr.textContent >= 10); assert.equal(+e.mErr.textContent, 0);
    assert.equal(a.maxEm(), 1);
  } finally { a.encerrar(); }
  await sleep(60); const c = a.calls(); await sleep(300); assert.equal(a.calls(), c, 'inferência continuou após encerrar');
});
test('app: sem rVFC o painel informa que o FPS da câmera não está disponível', async () => {
  const a = await montar({}); try { await a.iniciar(); await sleep(700); assert.match(a.els.mCam.textContent, /indisponível/); } finally { a.encerrar(); }
});
test('app: modelo "carregando" e falha de carga são indicados; nada fica rodando', async () => {
  const a = await montar({loadMs: 250}); const p = a.iniciar(); await sleep(60);
  assert.match(a.els.mModelo.textContent, /carregando/); await p; assert.match(a.els.mModelo.textContent, /^pronto/); a.encerrar();
  const b = await montar({loadFalha: true}); await b.iniciar(); await sleep(150);
  assert.match(b.els.mModelo.textContent, /erro ao carregar/); assert.match(b.els.status.textContent, /Erro/); assert.equal(b.calls(), 0); assert.equal(b.els.btnIniciar.disabled, false);
});
test('app: pausa/retoma 40× e encerra sem cadeia duplicada nem concorrência', async () => {
  const a = await montar({detectMs: 15, vals: {intervalo: 40}, rvfcMs: 16}); const ini = []; a.aoDetectar = t => ini.push(t); try {
    await a.iniciar(); await sleep(400); let c0 = a.calls(); await sleep(800); const antes = a.calls() - c0;
    for (let k = 0; k < 40; k++){ a.pausar(); await sleep(Math.random() * 40); a.pausar(); await sleep(Math.random() * 40); }
    await sleep(400); c0 = a.calls(); const i0 = ini.length; await sleep(800); const depois = a.calls() - c0;
    assert.equal(a.maxEm(), 1); assert.ok(depois <= antes * 1.25 + 1, `antes=${antes} depois=${depois}`);
    const esp = ini.slice(i0).map((t, k, x) => k ? t - x[k-1] : Infinity).slice(1);
    assert.ok(Math.min(...esp) >= 36, 'espaçamento mínimo ' + Math.min(...esp).toFixed(1) + ' ms');
  } finally { a.encerrar(); }
});
test('app: erros repetidos do modelo avisam uma vez, contam e o app segue tentando', async () => {
  const a = await montar({detectFalha: true}); try { await a.iniciar(); await sleep(900);
    assert.equal(a.falas.filter(t => t === 'Atenção: não foi possível avaliar a passagem. Pare e aguarde.').length, 1);
    assert.ok(+a.els.mErr.textContent >= 3); assert.ok(a.calls() > 5); assert.equal(+a.els.mFr.textContent, 0);
  } finally { a.encerrar(); }
});
test('app: alertas preservados (veículos agrupados, oscilação não repete, pessoa à frente não corta a fala em loop)', async () => {
  const rod = async (script, ms = 1500) => { const a = await montar({script, vals: {intervalo: 20}}); try { await a.iniciar(); await sleep(ms); } finally { a.encerrar(); } return a.falas.filter(t => !/^Assistência/.test(t)); };
  assert.deepEqual(await rod([[d('car', [250, 150, 140, 100]), d('truck', [260, 160, 140, 100])]]), ['Dois veículos à frente. Não foi possível confirmar uma passagem.']);
  const cad1 = d('chair', [40, 150, 80, 150]), cad2 = d('chair', [120, 160, 80, 150]);
  assert.deepEqual(await rod([[cad1, cad2], [cad1]]), ['Duas cadeiras à esquerda.']);
  const pess = d('person', [270, 100, 100, 250]);
  assert.equal((await rod([[pess, d('person', [290, 110, 90, 230])], [pess]])).length, 1);
});

// =====================================================================================================================
// ORIENTAÇÃO ESPACIAL. TUDO AQUI É SIMULADO: detecções, "avaliações de passagem" e imagens são SINTÉTICAS, escritas à mão.
// Os testes de decisão e de mensagens validam a LÓGICA. Os testes do avaliador de piso rodam o algoritmo REAL, mas em imagens artificiais
// (cores uniformes): provam que o código faz o que descreve, NÃO que ele acerta em fotos reais de fábrica. Não validam COCO-SSD, câmera nem celular.
// =====================================================================================================================
const W = 640, H = 480;
const og = (cls, cx, w = .15, h = .4, n = 1, inv = false) => { const b = [cx*W - w*W/2, 100, w*W, h*H]; return {cls, info: P.CLASSES[cls], z: P.zonaDe(b, W, inv), n, area: b[2]*b[3]/(W*H)}; };
const E_ = () => og('chair', .15), F_ = () => og('chair', .5), D_ = () => og('chair', .85);           // cadeira na esquerda / frente / direita
const BOA = (extra = {}) => Object.assign({livre: .9, continuidade: .9, larguraRel: .8, confianca: .8}, extra);   // região com evidência positiva
const RUIM = {livre: .2, continuidade: .2, larguraRel: .1, confianca: .8};
// avaliação de passagem SIMULADA: por padrão as três regiões têm boa evidência (as obstruídas por objeto serão descartadas pela decisão)
const segSim = (reg = {}, extra = {}) => Object.assign({estado: 'ok', origem: 'simulado', tCaptura: performance.now(), cobertura: .95, idadeMs: 100, regioes: Object.assign({esquerda: BOA(), frente: BOA(), direita: BOA()}, reg)}, extra);
const NENHUM = 'Nenhum obstáculo reconhecido nas classes monitoradas. Isso não indica caminho livre.';   // mensagem ÚNICA para "nenhum objeto" (padrão e pista)
const piso = r => Object.assign({idadeMs: 0, origem: 'heuristica_cor_piso', tCaptura: performance.now()}, r);   // resultado do avaliador de piso com o contrato de fonte (origem + instante de captura)
const detSim = (extra = {}) => Object.assign({estado: 'ok', origem: 'simulado', tCaptura: performance.now(), idadeMs: 0}, extra);   // detecção SIMULADA, recém-capturada
const dec = (grupos, extra = {}) => P.decidirOrientacao(Object.assign({grupos, deteccao: detSim()}, extra));
const fala = (grupos, extra = {}) => { const d = dec(grupos, extra); return {d, p: grupos.length ? P.planejar(grupos, d) : P.planejarSemObjetos(d)}; };

test('[simulado] Regra 1: centro e direita obstruídos, passagem à esquerda validada', () => {
  const {d, p} = fala([F_(), D_()], {seg: segSim()});
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.deepEqual(d.bloqueadas.sort(), ['direita', 'frente']); assert.deepEqual(d.passagens, ['esquerda']);
  assert.equal(d.evidencias.zonas.esquerda.valida, true); assert.equal(p.texto, 'Obstáculo à frente e à direita. Possível passagem à esquerda.');
});
test('[simulado] Regra 2: centro e esquerda obstruídos, passagem à direita validada', () => {
  const {d, p} = fala([F_(), E_()], {seg: segSim()});
  assert.equal(d.decisao, 'possivel_passagem_direita'); assert.equal(p.texto, 'Obstáculo à frente e à esquerda. Possível passagem à direita.');
});
test('[simulado] Regra 3: laterais obstruídas, passagem central validada (e sem validação, não indica o centro)', () => {
  let {d, p} = fala([E_(), D_()], {seg: segSim()});
  assert.equal(d.decisao, 'possivel_passagem_centro'); assert.deepEqual(d.passagens, ['frente']); assert.equal(p.texto, 'Obstáculos nas laterais. Possível passagem pelo centro.');
  ({d, p} = fala([E_(), D_()], {seg: segSim({frente: BOA({continuidade: .3})})}));
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Cadeira à esquerda e cadeira à direita. Não foi possível confirmar uma passagem.');
  assert.match(p.texto, /Não foi possível confirmar uma passagem\.$/); assert.doesNotMatch(p.texto, /pelo centro/);
  ({d, p} = fala([E_(), D_()]));                                                    // sem nenhuma avaliação de passagem
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(d.passagens, []);
});
test('[simulado] Regra 4: centro obstruído e as duas laterais validadas: informa as duas; só escolhe uma por critério objetivo', () => {
  let {d, p} = fala([F_()], {seg: segSim()});                                       // pontuações iguais
  assert.equal(d.decisao, 'possiveis_passagens_esquerda_e_direita'); assert.deepEqual(d.passagens, ['esquerda', 'direita']);
  assert.equal(p.texto, 'Obstáculo à frente. Passagens possíveis à esquerda e à direita.');
  ({d, p} = fala([F_()], {seg: segSim({esquerda: BOA({larguraRel: 1, continuidade: 1, confianca: .9}), direita: BOA({larguraRel: .55, continuidade: .7, confianca: .65})})}));
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.deepEqual(d.passagens, ['esquerda']); assert.match(d.evidencias.criterio, /largura×continuidade×confiança/);
  assert.equal(p.texto, 'Obstáculo à frente. Possível passagem à esquerda.');
  ({d} = fala([F_()], {seg: segSim({esquerda: BOA({larguraRel: .55, continuidade: .7, confianca: .65}), direita: BOA({larguraRel: 1, continuidade: 1, confianca: .9})})}));
  assert.equal(d.decisao, 'possivel_passagem_direita');                               // espelho: o critério não favorece um lado fixo
});
test('[simulado] Regra 5: todas as regiões obstruídas → não indica direção, manda parar (urgente)', () => {
  const {d, p} = fala([E_(), F_(), D_()], {seg: segSim()});
  assert.equal(d.decisao, 'obstaculos_todas_direcoes'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Obstáculos em todas as direções analisadas. Pare e solicite auxílio.');
  assert.equal(p.urgente, true);
});
test('[simulado] Regra 6: só o centro obstruído; uma lateral validada, nenhuma validada, ou lateral só "sem objeto"', () => {
  let {d, p} = fala([F_()], {seg: segSim({direita: RUIM})});
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.equal(p.texto, 'Obstáculo à frente. Possível passagem à esquerda.');
  ({d, p} = fala([F_()], {seg: segSim({esquerda: RUIM, direita: RUIM})}));
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.equal(p.texto, 'Cadeira à frente. Não foi possível confirmar uma passagem.');
  ({d, p} = fala([og('person', .5)]));                                              // sem avaliação: sem caixas nas laterais NÃO é passagem
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.equal(p.texto, 'Pessoa à frente. Não foi possível confirmar uma passagem.');
});
test('[simulado] Regra 7: obstáculo só à esquerda / só à direita; o lado oposto só é indicado com passagem validada', () => {
  let {d, p} = fala([E_()], {seg: segSim()});
  assert.equal(d.decisao, 'possivel_passagem_direita'); assert.equal(p.texto, 'Obstáculo à esquerda. Possível passagem à direita.');
  ({d, p} = fala([D_()], {seg: segSim()}));
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.equal(p.texto, 'Obstáculo à direita. Possível passagem à esquerda.');
  for (const [seg, re] of [[undefined, /sem avaliação de passagem/], [segSim({esquerda: RUIM}), /pouca área livre/], [segSim({esquerda: BOA({larguraRel: .2})}), /largura/], [segSim({esquerda: BOA({continuidade: .2})}), /continuidade/],
                           [segSim({esquerda: BOA({confianca: .3})}), /baixa confiança/], [segSim({}, {regioes: {direita: BOA()}}), /sem dados da região/]]){
    ({d, p} = fala([D_()], {seg}));
    assert.equal(d.decisao, 'obstaculo_direita', String(re)); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Cadeira à direita.'); assert.match(d.motivos.join(' '), re);
  }
  ({d} = fala([D_()], {seg: segSim(), prof: {estado: 'ok', origem: 'simulado', tCaptura: performance.now(), idadeMs: 50, regioes: {esquerda: {proximidade: .9}}}}));   // profundidade relativa só pode VETAR
  assert.equal(d.decisao, 'obstaculo_direita'); assert.match(d.evidencias.zonas.esquerda.motivo, /profundidade relativa/);
  ({d} = fala([D_()], {seg: segSim(), candidatos: [{z: 'esquerda', area: .1, nome: 'cadeira'}]}));          // possível objeto de baixa confiança no lado
  assert.equal(d.decisao, 'obstaculo_direita');
});
test('[simulado] Cenário E: nenhum objeto reconhecido nunca vira caminho livre nem direção, nem com avaliação de piso favorável', () => {
  for (const seg of [undefined, segSim({frente: RUIM}), segSim()]){
    const {d, p} = fala([], {seg});
    assert.equal(d.decisao, 'nenhum_objeto_reconhecido'); assert.deepEqual(d.passagens, []); assert.equal(d.permiteDirecao, false);
    assert.equal(p.texto, NENHUM); assert.ok(d.limitacoes.includes('ausencia_de_deteccao_nao_indica_caminho_livre'));
  }
  // a evidência de piso continua visível na decisão (transparência), mas não vira permissão: avaliar ≠ autorizar
  assert.equal(dec([], {seg: segSim()}).regioes.frente, 'avaliada_favoravel'); assert.equal(dec([], {seg: segSim()}).permiteDirecao, false);
});
test('[simulado] Regra 8: falha do modelo, baixa confiança e dados desatualizados não inventam direção', () => {
  for (const deteccao of [{estado: 'falha', motivo: 'x'}, {estado: 'incompleto'}, {estado: 'ok', idadeMs: 5000}]){
    const {d, p} = fala([D_()], {seg: segSim(), deteccao});
    assert.equal(d.decisao, 'analise_insuficiente'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Não foi possível avaliar a passagem adequadamente.');
    assert.doesNotMatch(p.texto, /esquerda|direita|frente|centro/);
  }
  let r = fala([], {candidatos: [{z: 'frente', area: .2, nome: 'pessoa'}], seg: segSim()});                  // só baixa confiança
  assert.equal(r.d.decisao, 'analise_insuficiente'); assert.ok(r.d.limitacoes.includes('baixa_confianca')); assert.equal(r.p.texto, 'Não foi possível avaliar a passagem adequadamente.');
  for (const seg of [segSim({}, {idadeMs: 5000}), segSim({}, {estado: 'falha'}), segSim({}, {estado: 'incompleto', motivo: 'referência coberta'}), segSim({}, {cobertura: .2})]){   // passagem sem dados utilizáveis
    r = fala([F_()], {seg});
    assert.equal(r.d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(r.d.passagens, []); assert.ok(r.d.limitacoes.includes('passagem_nao_avaliada'));
    assert.equal(r.p.texto, 'Cadeira à frente. Não foi possível avaliar a passagem adequadamente.');
  }
  r = fala([D_()], {seg: segSim({}, {idadeMs: 5000})}); assert.equal(r.p.texto, 'Cadeira à direita.');           // obstáculo continua sendo informado
});
test('[simulado] estabilização: passagem que pisca não liga; falha isolada não derruba; objeto na região derruba na hora', () => {
  const e = P.criarEstabilizadorAlt(), ciclo = (b, im = []) => e.filtrar(b, im);
  for (let i = 0; i < 20; i++) assert.deepEqual(ciclo(i % 2 ? ['esquerda'] : []), []);
  ciclo(['esquerda']); ciclo(['esquerda']); assert.deepEqual(ciclo(['esquerda']), ['esquerda']);
  assert.deepEqual(ciclo([]), ['esquerda']); assert.deepEqual(ciclo(['esquerda']), ['esquerda']);
  ciclo([]); ciclo([]); assert.deepEqual(ciclo([]), []);
  ciclo(['frente']); ciclo(['frente']); assert.deepEqual(ciclo(['frente']), ['frente']);                       // vale também para o centro
  assert.deepEqual(ciclo(['frente'], ['frente']), []);
  const estab = P.criarEstabilizadorAlt(), d = () => dec([D_()], {seg: segSim(), estab}).decisao;
  assert.deepEqual([d(), d(), d()], ['obstaculo_direita', 'obstaculo_direita', 'possivel_passagem_esquerda']);
});
test('[simulado] a expressão "ocupando boa parte da imagem" não existe em lugar nenhum (código, HTML, mensagens, registros)', () => {
  for (const t of [fs.readFileSync(HTML, 'utf8'), SC, NUCLEO_SRC]) assert.ok(!/ocupando boa parte/i.test(t), 'ainda existe no HTML ou no JS');
  const grande = [{cls: 'dining table', info: P.CLASSES['dining table'], z: 'frente', n: 1, area: .8}, {cls: 'person', info: P.CLASSES.person, z: 'esquerda', n: 1, area: .6}];
  for (const seg of [undefined, segSim()]) for (const gs of [grande, [grande[0]], [grande[1]]]){ const p = P.planejar(gs, dec(gs, {seg})); assert.ok(!/ocupando|boa parte|imagem/i.test(p.texto + p.curto), p.texto); }
});

// ---------- avaliador de passagem (algoritmo REAL, imagens ARTIFICIAIS) ----------
const imagem = (fn, w = 64, h = 48) => { const data = new Uint8ClampedArray(w*h*4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){ const c = fn(x, y), i = 4*(y*w + x); data[i] = c[0]; data[i+1] = c[1]; data[i+2] = c[2]; data[i+3] = 255; } return {data, w, h}; };
const CHAO = [120, 118, 115], OUTRO = [40, 70, 160];
test('[simulado] avaliador de piso: piso uniforme dá as três regiões livres, contínuas e largas; a decisão correspondente sai', () => {
  const r = P.avaliarPassagemPorCor(imagem(() => CHAO), []);
  assert.equal(r.estado, 'ok'); assert.equal(r.metodo, 'heuristica_cor_piso');
  for (const z of ['esquerda', 'frente', 'direita']){ assert.ok(r.regioes[z].livre > .95 && r.regioes[z].continuidade === 1 && r.regioes[z].larguraRel === 1, z); assert.ok(r.regioes[z].confianca <= .9); }
  assert.equal(dec([F_()], {seg: piso(r)}).decisao, 'possiveis_passagens_esquerda_e_direita');
});
test('[simulado] avaliador de piso: caixa de objeto e mudança de cor invalidam só a região afetada; a caixa é aplicada na orientação BRUTA e os lados seguem a inversão', () => {
  const cx = {x: .35, y: .3, w: .3, h: .5};                                           // caixa no centro da imagem (acima da faixa de referência do piso)
  let r = P.avaliarPassagemPorCor(imagem(() => CHAO), [cx]);
  assert.ok(r.regioes.frente.livre < .5 && r.regioes.frente.continuidade < .5); assert.ok(r.regioes.esquerda.livre > .95 && r.regioes.direita.livre > .95);
  const dir = {x: .7, y: .3, w: .3, h: .65};                                           // caixa na DIREITA da imagem
  r = P.avaliarPassagemPorCor(imagem(() => CHAO), [dir], false); assert.ok(r.regioes.direita.livre < .5 && r.regioes.esquerda.livre > .95);
  r = P.avaliarPassagemPorCor(imagem(() => CHAO), [dir], true);  assert.ok(r.regioes.esquerda.livre < .5 && r.regioes.direita.livre > .95);   // câmera invertida: lado do USUÁRIO é o oposto
  r = P.avaliarPassagemPorCor(imagem((x, y) => x >= 43 && y >= 24 ? OUTRO : CHAO), []);  // terço direito, metade inferior, outra cor (ex.: parede ou piso diferente)
  assert.ok(r.regioes.direita.livre < .2 && r.regioes.esquerda.livre > .95);
  r = P.avaliarPassagemPorCor(imagem((x, y) => x >= 43 && y >= 38 && y < 42 ? OUTRO : CHAO), []);   // faixa horizontal perto da base, cortando o caminho: quebra a continuidade
  assert.ok(r.regioes.direita.livre > .8 && r.regioes.direita.continuidade < .2);
  r = P.avaliarPassagemPorCor(imagem((x, y) => x >= 43 && x < 58 && y >= 24 ? OUTRO : CHAO), []);   // só ~30% da largura da região continua livre
  assert.ok(r.regioes.direita.larguraRel < .5);
  assert.equal(dec([E_(), F_()], {seg: piso(r)}).decisao, 'passagem_nao_confirmada');   // largura insuficiente: não valida a direita
});
test('[simulado] avaliador de piso: sem referência confiável não valida nada (incompleto), e a decisão diz que não avaliou', () => {
  const casos = [[imagem(() => [5, 5, 5]), /escura/], [imagem(() => [250, 250, 250]), /clara/],
                 [imagem((x, y) => (x * 7 + y * 13) % 2 ? [20, 200, 20] : [220, 30, 120]), /homogênea/]];
  for (const [img, re] of casos){ const r = P.avaliarPassagemPorCor(img, []); assert.equal(r.estado, 'incompleto'); assert.match(r.motivo, re); }
  let r = P.avaliarPassagemPorCor(imagem(() => CHAO), [{x: .3, y: .7, w: .4, h: .3}]); assert.equal(r.estado, 'incompleto'); assert.match(r.motivo, /coberta/);   // objeto sobre a referência
  assert.equal(P.avaliarPassagemPorCor({data: new Uint8ClampedArray(4), w: 64, h: 48}, []).estado, 'falha');
  const d = dec([F_()], {seg: piso(r)});
  assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(d.passagens, []); assert.equal(P.planejar([F_()], d).texto, 'Cadeira à frente. Não foi possível avaliar a passagem adequadamente.');
});

// ---------- app completo (simulado) ----------
const naoInicio = fal => fal.filter(t => !/^Assistência/.test(t));
const cadE = d('chair', [40, 150, 80, 150]);          // caixa à ESQUERDA da imagem (x 40..120 de 640)
const cadC = d('chair', [270, 150, 100, 150]), cadD = d('chair', [540, 150, 80, 150]);
test('[simulado] app: avaliação de piso ligada, pipeline completo: objeto detectado + imagem artificial → mensagem da Regra 6/4 e barras coerentes', async () => {
  const a = await montar({script: [[cadC]], vals: {intervalo: 20, passagem: 'ligada'}, quadro: () => imagem(() => CHAO)});
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente. Passagens possíveis à esquerda e à direita.']);   // só depois do aquecimento: nada de "sem passagem" cedo demais
  assert.equal(a.els.oDec.textContent, 'possiveis_passagens_esquerda_e_direita'); assert.match(a.els.oSeg.textContent, /E 10\d?%|E 100%/);
  const b = await montar({script: [[cadC]], vals: {intervalo: 20, passagem: 'ligada'}, quadro: () => null});    // captura falha: não inventa passagem
  try { await b.iniciar(); await sleep(1000); } finally { b.encerrar(); }
  assert.deepEqual(naoInicio(b.falas), ['Cadeira à frente. Não foi possível avaliar a passagem adequadamente.']);
});
test('[simulado] app: passagem externa oscilando a cada ciclo não muda a fala; estável gera UMA mensagem com a passagem', async () => {
  let a = await montar({script: [[cadD]], vals: {intervalo: 20}}); let k = 0;
  a.aoDetectar = () => { k++; a.win.VisioIndustria.receberSegmentacao(k % 2 ? segSim() : segSim({esquerda: RUIM})); };
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']);
  a = await montar({script: [[cadD]], vals: {intervalo: 20}}); a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim());   // reenvia a cada ciclo, como um modelo que atualiza
  try { await a.iniciar(); await sleep(2000); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à direita. Possível passagem à esquerda.']);
});
test('[simulado] app: nunca interrompe fala em andamento; repetição por tempo usa só o obstáculo; aviso de "sem objeto" sai uma vez', async () => {
  let a = await montar({script: [[cadC]], vals: {intervalo: 20}}); a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim());
  try { await a.iniciar(); a.ss.speaking = true; const c0 = a.cancels(); await sleep(1200); assert.equal(a.cancels(), c0, 'cancelou fala em andamento'); assert.deepEqual(naoInicio(a.falas), []); } finally { a.encerrar(); }
  a = await montar({script: [[cadC]], vals: {intervalo: 20, cool: 1}});                                       // cadeira à frente, repetição a cada 2 s
  try { await a.iniciar(); await sleep(2700); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas).slice(0, 2), ['Cadeira à frente. Não foi possível confirmar uma passagem.', 'Cadeira à frente.']);
  const script = [...Array(10).fill([cadE]), ...Array(500).fill([])];
  a = await montar({script, vals: {intervalo: 20}});
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Cadeira à esquerda.', NENHUM]);
});
test('[simulado] app: resultado nulo do modelo → "não foi possível avaliar" uma vez, sem direção, sem estourar erro de ciclo', async () => {
  const a = await montar({script: [null], vals: {intervalo: 20}});
  try { await a.iniciar(); await sleep(900); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Não foi possível avaliar a passagem adequadamente.']); assert.equal(+a.els.mErr.textContent, 0); assert.equal(a.els.oDec.textContent, 'analise_insuficiente');
});
test('[simulado] app: o lado anunciado, as barras e os rótulos seguem o lado do USUÁRIO (câmera normal, invertida, frontal)', async () => {
  const bE = [40, 100, 80, 150], bD = [520, 100, 80, 150], bC = [280, 100, 80, 150];
  assert.equal(P.zonaDe(bE, 640), 'esquerda'); assert.equal(P.zonaDe(bD, 640), 'direita'); assert.equal(P.zonaDe(bC, 640), 'frente');
  assert.equal(P.zonaDe(bE, 640, true), 'direita'); assert.equal(P.zonaDe(bD, 640, true), 'esquerda'); assert.equal(P.zonaDe(bC, 640, true), 'frente');
  assert.deepEqual(P.resolverLados('auto', 'environment'), {invertido: false, motivo: 'câmera traseira'});
  assert.equal(P.resolverLados('auto', 'user').invertido, true); assert.equal(P.resolverLados('auto', '').invertido, false);
  assert.equal(P.resolverLados('normal', 'user').invertido, false); assert.equal(P.resolverLados('invertido', 'environment').invertido, true);
  assert.deepEqual(P.rotulosLados(false), ['esquerda', 'direita']); assert.deepEqual(P.rotulosLados(true), ['direita', 'esquerda']);
  // a regra completa respeita a inversão: obstáculo no canto ESQUERDO da imagem com câmera invertida é obstáculo à DIREITA; a passagem fica à ESQUERDA do usuário
  const gs = [og('chair', .1, .15, .4, 1, true)]; assert.equal(P.planejar(gs, dec(gs, {seg: segSim()})).texto, 'Obstáculo à direita. Possível passagem à esquerda.');
  const rodar = async (vals, facing) => { const a = await montar({script: [[cadE]], vals: Object.assign({intervalo: 20}, vals), facing}); try { await a.iniciar(); await sleep(700); } finally { a.encerrar(); } return {f: naoInicio(a.falas), a}; };
  let x = await rodar({lados: 'normal'}, 'environment'); assert.deepEqual(x.f, ['Cadeira à esquerda.']); assert.equal(x.a.els.rotE.textContent, 'esquerda'); assert.equal(x.a.els.rotD.textContent, 'direita');
  x = await rodar({lados: 'invertido'}, 'environment'); assert.deepEqual(x.f, ['Cadeira à direita.']); assert.equal(x.a.els.rotE.textContent, 'direita'); assert.match(x.a.els.oLados.textContent, /invertidos/);
  x = await rodar({lados: 'auto'}, 'user'); assert.deepEqual(x.f, ['Cadeira à direita.']);
  x = await rodar({lados: 'auto'}, 'environment'); assert.deepEqual(x.f, ['Cadeira à esquerda.']);
  x = await rodar({lados: 'auto'}, ''); assert.deepEqual(x.f, ['Cadeira à esquerda.']);
  // pipeline de pixels + inversão no app: caixa na esquerda da imagem e câmera invertida → obstáculo à direita; piso livre à esquerda do usuário
  const y = await montar({script: [[cadE]], vals: {intervalo: 20, lados: 'invertido', passagem: 'ligada'}, quadro: () => imagem(() => CHAO)});
  try { await y.iniciar(); await sleep(1500); } finally { y.encerrar(); }
  assert.deepEqual(naoInicio(y.falas), ['Obstáculo à direita. Possível passagem à esquerda.']);
});

// =====================================================================================================================
// MODO PISTA CONTROLADA (EXPERIMENTAL). TUDO AQUI É SIMULADO: detecções sintéticas escritas à mão.
// Validam a LÓGICA de decisão, as mensagens e a estabilidade. NÃO validam COCO-SSD, câmera, celular nem a pista física.
// Neste modo "região disponível" é uma PREMISSA da pista (sem obstáculo confirmado e sem possível objeto), não uma prova da câmera.
// =====================================================================================================================
const decP = (grupos, extra = {}) => P.decidirOrientacao(Object.assign({grupos, modo: 'pista', deteccao: detSim()}, extra));
const falaP = (grupos, extra = {}) => { const d = decP(grupos, extra); return {d, p: grupos.length ? P.planejar(grupos, d) : P.planejarSemObjetos(d)}; };
const PERMITIDAS = new Set(['Obstáculo à frente. Desvie pela esquerda.', 'Obstáculo à frente. Desvie pela direita.', 'Obstáculo à esquerda. Siga pela direita.', 'Obstáculo à direita. Siga pela esquerda.',
  'Obstáculo à frente e à esquerda. Desvie pela direita.', 'Obstáculo à frente e à direita. Desvie pela esquerda.', 'Laterais obstruídas. Siga pelo centro.',
  'Pare. Obstáculos identificados em todas as direções.', 'Não foi possível avaliar a passagem. Pare e aguarde.', NENHUM]);

test('[simulado][pista] 1/10. obstáculo só no centro, duas passagens: escolha consistente (prioridade fixa) e mensagem de desvio', () => {
  const {d, p} = falaP([F_()]);
  assert.equal(d.decisao, 'desvio_esquerda'); assert.deepEqual(d.bloqueadas, ['frente']); assert.deepEqual(d.passagens, ['esquerda']); assert.deepEqual(d.evidencias.opcoes, ['esquerda', 'direita']);
  assert.equal(p.texto, 'Obstáculo à frente. Desvie pela esquerda.'); assert.match(d.motivos.join(' '), /prioridade fixa/);
  for (let i = 0; i < 50; i++) assert.equal(decP([F_()]).decisao, 'desvio_esquerda');                          // determinístico: nunca aleatório
  const s = decP([F_()], {ultimaEscolha: 'direita'});                                                         // escolha anterior vale enquanto a região continuar disponível
  assert.equal(s.decisao, 'desvio_direita'); assert.equal(P.planejar([F_()], s).texto, 'Obstáculo à frente. Desvie pela direita.'); assert.match(s.motivos.join(' '), /escolha anterior/);
  const so = decP([F_()], {candidatos: [{z: 'esquerda', area: .1, nome: 'cadeira'}], ultimaEscolha: 'esquerda'});   // anterior deixou de valer: troca de verdade, uma vez
  assert.equal(so.decisao, 'desvio_direita');
  assert.ok(decP([F_()]).limitacoes.includes('disponibilidade_assumida_pela_pista_nao_comprovada_pela_camera'));
});
test('[simulado][pista] 2. obstáculo à esquerda → siga pela direita', () => {
  const {d, p} = falaP([E_()]);
  assert.equal(d.decisao, 'seguir_direita'); assert.deepEqual(d.bloqueadas, ['esquerda']); assert.equal(p.texto, 'Obstáculo à esquerda. Siga pela direita.');
});
test('[simulado][pista] 3. obstáculo à direita → siga pela esquerda', () => {
  const {d, p} = falaP([D_()]);
  assert.equal(d.decisao, 'seguir_esquerda'); assert.equal(p.texto, 'Obstáculo à direita. Siga pela esquerda.');
});
test('[simulado][pista] 4. centro e esquerda obstruídos → desvie pela direita', () => {
  const {d, p} = falaP([F_(), E_()]);
  assert.equal(d.decisao, 'desvio_direita'); assert.deepEqual(d.bloqueadas.sort(), ['esquerda', 'frente']); assert.equal(p.texto, 'Obstáculo à frente e à esquerda. Desvie pela direita.');
});
test('[simulado][pista] 5. centro e direita obstruídos → desvie pela esquerda', () => {
  const {d, p} = falaP([F_(), D_()]);
  assert.equal(d.decisao, 'desvio_esquerda'); assert.equal(p.texto, 'Obstáculo à frente e à direita. Desvie pela esquerda.');
});
test('[simulado][pista] 6. laterais obstruídas, centro disponível → siga pelo centro', () => {
  const {d, p} = falaP([E_(), D_()]);
  assert.equal(d.decisao, 'seguir_centro'); assert.deepEqual(d.passagens, ['frente']); assert.equal(p.texto, 'Laterais obstruídas. Siga pelo centro.');
});
test('[simulado][pista] 7. obstáculos nas três regiões → pare, sem direção, alerta urgente', () => {
  const {d, p} = falaP([E_(), F_(), D_()]);
  assert.equal(d.decisao, 'obstaculos_todas_direcoes'); assert.deepEqual(d.passagens, []); assert.equal(d.escolha, undefined);
  assert.equal(p.texto, 'Pare. Obstáculos identificados em todas as direções.'); assert.equal(p.urgente, true); assert.doesNotMatch(p.texto, /desvie|siga/i);
});
test('[simulado][pista] 8. nenhum obstáculo: não diz caminho livre; baixa confiança isolada não vira direção', () => {
  const {d, p} = falaP([]);
  assert.equal(d.decisao, 'nenhum_obstaculo_reconhecido'); assert.deepEqual(d.passagens, []); assert.deepEqual(d.bloqueadas, []);
  assert.equal(p.texto, NENHUM); assert.doesNotMatch(p.texto, /segur|desvie|siga/i);
  assert.ok(d.limitacoes.includes('ausencia_de_deteccao_nao_indica_caminho_livre'));
});
test('[simulado][pista] 9. resultado inválido, inconclusivo, baixa confiança ou dados velhos → "Pare e aguarde", sem direção', () => {
  for (const deteccao of [{estado: 'falha', motivo: 'x'}, {estado: 'incompleto'}, {estado: 'ok', idadeMs: 5000}]){
    const {d, p} = falaP([F_()], {deteccao});
    assert.equal(d.decisao, 'analise_insuficiente'); assert.deepEqual(d.passagens, []); assert.equal(p.texto, 'Não foi possível avaliar a passagem. Pare e aguarde.'); assert.doesNotMatch(p.texto, /esquerda|direita|centro|frente/);
  }
  let r = falaP([], {candidatos: [{z: 'frente', area: .2, nome: 'pessoa'}]});
  assert.equal(r.d.decisao, 'analise_insuficiente'); assert.equal(r.p.texto, 'Não foi possível avaliar a passagem. Pare e aguarde.');
  r = falaP([F_()], {candidatos: [{z: 'esquerda', area: .1, nome: 'x'}, {z: 'direita', area: .1, nome: 'x'}]});          // única saída possível está sob suspeita: não inventa
  assert.equal(r.d.decisao, 'analise_insuficiente'); assert.equal(r.p.texto, 'Não foi possível avaliar a passagem. Pare e aguarde.');
  r = falaP([E_(), D_()], {candidatos: [{z: 'frente', area: .1, nome: 'x'}]}); assert.equal(r.d.decisao, 'analise_insuficiente');
});
test('[simulado][pista] independe da heurística de cor: dado de passagem ruim, velho ou ausente não bloqueia nem muda a orientação', () => {
  const ruim = {estado: 'ok', origem: 'simulado', tCaptura: performance.now(), cobertura: .9, idadeMs: 0, regioes: {esquerda: {livre: .1, continuidade: 0, larguraRel: 0, confianca: .9}, frente: {livre: .1, continuidade: 0, larguraRel: 0, confianca: .9}, direita: {livre: .1, continuidade: 0, larguraRel: 0, confianca: .9}}};
  for (const seg of [undefined, ruim, {estado: 'falha'}, {estado: 'ok', cobertura: .9, idadeMs: 99999, regioes: {}}]) assert.equal(falaP([F_()], {seg}).p.texto, 'Obstáculo à frente. Desvie pela esquerda.');
  assert.equal(P.planejar([F_()], dec([F_()], {seg: ruim})).texto, 'Cadeira à frente. Não foi possível confirmar uma passagem.');   // modo padrão segue conservador
});
test('[simulado][pista] toda combinação de regiões produz só mensagens previstas, sem expressão proibida nem "livre/seguro" afirmativo', () => {
  const Z = [E_, F_, D_], vistos = new Set();
  for (let m = 0; m < 8; m++) for (const cand of [false, true]){
    const gs = Z.filter((_, i) => m & (1 << i)).map(f => f());
    const {d, p} = falaP(gs, {candidatos: cand ? [{z: 'frente', area: .2, nome: 'x'}] : []});
    vistos.add(p.texto); assert.ok(PERMITIDAS.has(p.texto), `${m}/${cand}: ${p.texto}`);
    assert.doesNotMatch(p.texto, /ocupando|boa parte|imagem|segur/i);
    if (d.passagens.length) assert.ok(!d.bloqueadas.includes(d.passagens[0]), 'indicou região obstruída');
  }
  assert.ok(vistos.size >= 8);
});
test('[simulado][pista] 14a. alerta urgente: pessoa ou veículo à frente é marcado urgente; cadeira não; novo item urgente muda a assinatura', () => {
  const pessoa = og('person', .5), carro = og('car', .5);
  assert.equal(P.planejar([pessoa], decP([pessoa])).urgente, true); assert.equal(P.planejar([carro], decP([carro])).urgente, true);
  assert.equal(P.planejar([F_()], decP([F_()])).urgente, false); assert.equal(P.planejar([og('person', .15)], decP([og('person', .15)])).urgente, false);
  assert.notEqual(P.planejar([pessoa], decP([pessoa])).ass, P.planejar([F_()], decP([F_()])).ass);
  assert.equal(P.planejar([F_(), og('chair', .5, .15, .4, 3)], decP([og('chair', .5, .15, .4, 3)])).ass, P.planejar([F_()], decP([F_()])).ass);   // contagem não muda a assinatura
});

// ---------- app completo, modo pista (simulado) ----------
const pista = (script, vals = {}, extra = {}) => montar(Object.assign({script, vals: Object.assign({intervalo: 20, modo: 'pista'}, vals)}, extra));
const cadCenter2 = d('chair', [200, 160, 90, 140]);                                                       // segunda cadeira, também na região central
test('[simulado][pista] app: cada configuração planejada fala a instrução certa, uma vez, sem usar a heurística de cor', async () => {
  const casos = [[[cadC], 'Obstáculo à frente. Desvie pela esquerda.'], [[cadE], 'Obstáculo à esquerda. Siga pela direita.'], [[cadD], 'Obstáculo à direita. Siga pela esquerda.'],
                 [[cadC, cadE], 'Obstáculo à frente e à esquerda. Desvie pela direita.'], [[cadC, cadD], 'Obstáculo à frente e à direita. Desvie pela esquerda.'],
                 [[cadE, cadD], 'Laterais obstruídas. Siga pelo centro.'], [[cadE, cadC, cadD], 'Pare. Obstáculos identificados em todas as direções.']];
  for (const [dets, msg] of casos){
    let chamadas = 0; const a = await pista([dets], {passagem: 'ligada'}, {quadro: () => { chamadas++; return imagem(() => CHAO); }});
    try { await a.iniciar(); await sleep(800); } finally { a.encerrar(); }
    assert.deepEqual(naoInicio(a.falas), [msg], msg); assert.equal(chamadas, 0, 'o modo pista não deve usar a heurística de piso');
    assert.match(a.els.oDec.textContent, /pista experimental/); assert.equal(a.els.oSeg.textContent, 'não usada no modo pista');
  }
});
test('[simulado][pista] app 11. oscilação temporária da detecção não troca nem repete a orientação', async () => {
  const ciclo = [[cadC], [cadC], [], [cadC], [cadC], [cadC], [], [cadC], [cadC], [cadC], [], [cadC]];       // falhas isoladas de 1 ciclo, dentro da tolerância
  const a = await pista([...ciclo, ...ciclo, ...ciclo, ...ciclo]);
  try { await a.iniciar(); await sleep(1300); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente. Desvie pela esquerda.']);
});
test('[simulado][pista] app 12. mesma orientação não é repetida a cada análise; mudar a contagem de objetos na região não gera nova fala; repete só após o intervalo', async () => {
  let a = await pista([...Array(15).fill([cadC]), ...Array(500).fill([cadC, cadCenter2])]);
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente. Desvie pela esquerda.']); assert.ok(+a.els.mSup.textContent > 10, 'suprimidas: ' + a.els.mSup.textContent);
  a = await pista([[cadC]], {cool: 1});
  try { await a.iniciar(); await sleep(2700); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas).slice(0, 2), ['Obstáculo à frente. Desvie pela esquerda.', 'Obstáculo à frente. Desvie pela esquerda.']);      // reafirma depois do cooldown
  assert.ok(naoInicio(a.falas).length <= 2);
});
test('[simulado][pista] app 13. obstáculo que muda de região: a orientação muda uma vez, depois de confirmada', async () => {
  const a = await pista([...Array(12).fill([cadC]), ...Array(500).fill([cadE])]);
  try { await a.iniciar(); await sleep(2400); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente. Desvie pela esquerda.', 'Obstáculo à esquerda. Siga pela direita.']);
});
test('[simulado][pista] app 14b. alerta urgente interrompe fala em andamento; baixa prioridade nunca interrompe', async () => {
  const pessoaC = d('person', [270, 100, 110, 300]);
  const a = await pista([...Array(12).fill([cadE]), ...Array(500).fill([cadE, pessoaC])]); let c0 = 0;
  try {
    await a.iniciar(); a.ss.speaking = true; c0 = a.cancels();
    await sleep(250); assert.equal(a.cancels(), c0, 'baixa prioridade cancelou fala'); assert.deepEqual(naoInicio(a.falas), []);
    await sleep(900);
  } finally { a.encerrar(); }
  assert.ok(a.cancels() > c0, 'o alerta urgente deveria ter cancelado a fala em curso'); assert.deepEqual(naoInicio(a.falas), ['Obstáculo à frente e à esquerda. Desvie pela direita.']);      // só o urgente passou, cancelando a fala em curso
});
test('[simulado][pista] app 9b. resultado nulo do modelo e erros repetidos → "Pare e aguarde", sem direção', async () => {
  let a = await pista([null]);
  try { await a.iniciar(); await sleep(900); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Não foi possível avaliar a passagem. Pare e aguarde.']); assert.equal(a.els.oDec.textContent, 'analise_insuficiente [pista experimental]');
  a = await pista([[cadC]], {}, {detectFalha: true});
  try { await a.iniciar(); await sleep(900); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Atenção: não foi possível avaliar a passagem. Pare e aguarde.']);
});
test('[simulado][pista] app 8b. sem nenhum obstáculo desde o início: silêncio; ao sumirem os obstáculos: um aviso que não afirma caminho livre', async () => {
  let a = await pista([[]]);
  try { await a.iniciar(); await sleep(700); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), []);
  a = await pista([...Array(10).fill([cadE]), ...Array(500).fill([])]);
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à esquerda. Siga pela direita.', NENHUM]);
});
test('[simulado][pista] app: lados invertidos valem também no modo pista; o modo aparece como experimental na interface', async () => {
  const a = await pista([[cadE]], {lados: 'invertido'});
  try { await a.iniciar(); await sleep(700); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à direita. Siga pela esquerda.']);
  assert.ok(/id="avisoPista"[^>]*>\s*<strong>Modo pista controlada \(EXPERIMENTAL\)/.test(fs.readFileSync(HTML, 'utf8')) && /Pista controlada \(experimental\)/.test(fs.readFileSync(HTML, 'utf8')));
  assert.equal(a.els.avisoPista.hidden, false);
});

// =====================================================================================================================
// ETAPA: PERCEPÇÃO ESPACIAL, CONTRATO TEMPORAL DAS FONTES E CONFIABILIDADE.
// TUDO AQUI É SIMULADO: detecções, avaliações de passagem, imagens e relógio são SINTÉTICOS. Validam a LÓGICA (decisão, validade temporal,
// estados, estabilização, agendador). NÃO validam a precisão do COCO-SSD, de uma segmentação, da câmera, da profundidade nem o desempenho em celular.
// Os testes "puros" usam relógio controlado (AGORA): nenhum depende de esperas reais.
// =====================================================================================================================
const AGORA = 100000;                                                  // relógio controlado (ms)
const detT = (extra = {}) => Object.assign({estado: 'ok', origem: 'simulado', tCaptura: AGORA - 80}, extra);                       // detecção capturada 80 ms antes de AGORA
const segT = (reg = {}, extra = {}) => Object.assign({estado: 'ok', origem: 'simulado', tCaptura: AGORA - 80, cobertura: .95,    // SEM idadeMs: a idade sai de AGORA - tCaptura
  regioes: Object.assign({esquerda: BOA(), frente: BOA(), direita: BOA()}, reg)}, extra);
const decT = (grupos, extra = {}) => P.decidirOrientacao(Object.assign({grupos, agora: AGORA, deteccao: detT()}, extra));
const falaT = (grupos, extra = {}) => { const x = decT(grupos, extra); return {d: x, p: grupos.length ? P.planejar(grupos, x) : P.planejarSemObjetos(x)}; };
const AFIRMATIVA = /livre|segur|garant|pode seguir|sem risco/i;
const semNenhum = t => t.replace(NENHUM, '');                          // a frase NENHUM nega "caminho livre"; o resto do texto não pode afirmar nada disso

// ---------- Cenários A a D e a separação entre "obstáculo", "evidência favorável/desfavorável" e "desconhecida" ----------
test('[simulado] Cenário A: obstáculo à direita + evidência válida à esquerda → possível alternativa, nunca garantia', () => {
  const {d, p} = falaT([D_()], {seg: segT()});
  assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.deepEqual(d.passagens, ['esquerda']); assert.equal(d.permiteDirecao, true);
  assert.deepEqual(d.regioes, {esquerda: 'avaliada_favoravel', frente: 'avaliada_favoravel', direita: 'obstaculo'});
  assert.equal(p.texto, 'Obstáculo à direita. Possível passagem à esquerda.'); assert.doesNotMatch(p.texto, AFIRMATIVA);
  assert.equal(d.fontes.segmentacao.estado, 'ok'); assert.equal(d.fontes.deteccao.idadeMs, 80);
});
test('[simulado] Cenário B: obstáculo à esquerda + evidência válida à direita → espelho do Cenário A', () => {
  const {d, p} = falaT([E_()], {seg: segT()});
  assert.equal(d.decisao, 'possivel_passagem_direita'); assert.deepEqual(d.regioes, {esquerda: 'obstaculo', frente: 'avaliada_favoravel', direita: 'avaliada_favoravel'});
  assert.equal(p.texto, 'Obstáculo à esquerda. Possível passagem à direita.'); assert.doesNotMatch(p.texto, AFIRMATIVA);
});
test('[simulado] Cenário C: obstáculo à frente sem alternativa identificável → não escolhe lado', () => {
  for (const seg of [undefined, segT({esquerda: RUIM, direita: RUIM}), segT({esquerda: BOA({confianca: .2}), direita: BOA({confianca: .2})})]){
    const {d, p} = falaT([F_()], {seg});
    assert.equal(d.decisao, 'passagem_nao_confirmada'); assert.deepEqual(d.passagens, []); assert.equal(d.permiteDirecao, false);
    assert.doesNotMatch(p.texto, /Possível|Passagens possíveis|esquerda|direita/); assert.match(p.texto, /^Cadeira à frente\. Não foi possível (confirmar|avaliar)/);
  }
});
test('[simulado] Cenário D: obstáculos nas três regiões → só informa e manda parar, sem direção', () => {
  const {d, p} = falaT([E_(), F_(), D_()], {seg: segT()});
  assert.equal(d.decisao, 'obstaculos_todas_direcoes'); assert.deepEqual(d.passagens, []); assert.deepEqual(Object.values(d.regioes), ['obstaculo', 'obstaculo', 'obstaculo']);
  assert.equal(p.texto, 'Obstáculos em todas as direções analisadas. Pare e solicite auxílio.'); assert.equal(p.urgente, true);
});
test('[simulado] região lateral sem detecção mas SEM dados suficientes é "desconhecida"; com dados desfavoráveis é "avaliada_desfavoravel" (estados distintos)', () => {
  let d = decT([D_()], {seg: segT({}, {regioes: {direita: BOA()}})}).regioes;                 // esquerda sem dados
  assert.equal(d.esquerda, 'desconhecida');
  d = decT([D_()], {seg: segT({esquerda: BOA({confianca: .3})})}).regioes; assert.equal(d.esquerda, 'desconhecida');       // baixa confiança = evidência insuficiente
  d = decT([D_()], {seg: segT({esquerda: RUIM})}).regioes; assert.equal(d.esquerda, 'avaliada_desfavoravel');              // evidência suficiente, mas contra
  d = decT([D_()]).regioes; assert.deepEqual([d.esquerda, d.frente], ['desconhecida', 'desconhecida']);                    // sem nenhuma avaliação
  const x = decT([D_()], {seg: segT({}, {regioes: {direita: BOA()}})});
  assert.equal(x.decisao, 'obstaculo_direita'); assert.deepEqual(x.passagens, []); assert.match(x.motivos.join(' '), /sem dados da região/);
});

// ---------- Falha, incompleto, indisponível, expirado, incompatível ----------
test('[simulado] detecção falha/incompleta/indisponível/expirada → análise insuficiente, todas as regiões desconhecidas, nenhuma alternativa', () => {
  for (const det of [detT({estado: 'falha', motivo: 'x'}), detT({estado: 'incompleto'}), detT({estado: 'carregando'}), detT({estado: 'falha_carregamento'}), detT({estado: 'indisponivel'}),
                     detT({estado: 'inferencia_expirada'}), detT({estado: 'camera_indisponivel'}), detT({tCaptura: AGORA - 1501})]){
    const {d, p} = falaT([D_()], {seg: segT(), deteccao: det});
    assert.equal(d.decisao, 'analise_insuficiente', det.estado); assert.deepEqual(d.passagens, []); assert.equal(d.permiteDirecao, false);
    assert.deepEqual(Object.values(d.regioes), ['desconhecida', 'desconhecida', 'desconhecida']);       // as marcas de obstáculo vieram de dado inválido: não são evidência
    assert.ok(d.ausentes.some(a => a.startsWith('detecção:')), det.estado); assert.equal(p.texto, 'Não foi possível avaliar a passagem adequadamente.');
  }
  assert.equal(decT([], {deteccao: detT({tCaptura: AGORA - 1501})}).fontes.deteccao.estado, 'desatualizado');
  assert.equal(decT([], {deteccao: detT({tCaptura: AGORA - 1500})}).fontes.deteccao.estado, 'ok');            // limite inclusivo: 1500 ms ainda vale, 1501 não
});
test('[simulado] detecção sem instante de captura nem idade: idade DESCONHECIDA nunca vale como recente', () => {
  const d = decT([D_()], {seg: segT(), deteccao: {estado: 'ok', origem: 'simulado'}});
  assert.equal(d.decisao, 'analise_insuficiente'); assert.ok(d.limitacoes.includes('deteccao_sem_referencia_temporal')); assert.equal(d.fontes.deteccao.idadeMs, null);
  assert.equal(P.idadeDe(undefined, AGORA), null); assert.equal(P.idadeDe({tCaptura: AGORA + 5}, AGORA), null);          // captura "no futuro" (relógios diferentes) também é inverificável
  assert.equal(P.idadeDe({tCaptura: AGORA - 40}, AGORA), 40); assert.equal(P.idadeDe({idadeMs: 7, tCaptura: 0}, AGORA), 7);
});
test('[simulado] resultado de passagem expirado, incompleto ou com falha: o obstáculo segue informado e nenhuma alternativa sai', () => {
  const casos = [[segT({}, {tCaptura: AGORA - 1501}), 'desatualizado'], [segT({}, {estado: 'falha', motivo: 'x'}), 'falha'], [segT({}, {estado: 'incompleto'}), 'incompleto'], [segT({}, {cobertura: .2}), 'incompleto'], [undefined, 'indisponivel']];
  for (const [seg, est] of casos){
    const {d, p} = falaT([D_()], {seg});
    assert.equal(d.decisao, 'obstaculo_direita', est); assert.deepEqual(d.passagens, []); assert.equal(d.fontes.segmentacao.estado, est); assert.equal(p.texto, 'Cadeira à direita.');
    assert.deepEqual([d.regioes.esquerda, d.regioes.direita], ['desconhecida', 'obstaculo']); assert.ok(d.ausentes.some(a => a.startsWith('passagem:')));
  }
});
test('[simulado] Cenário G: resultados de quadros incompatíveis NÃO são combinados, mesmo que cada um seja "recente"', () => {
  const det = detT({tCaptura: AGORA - 600});                                                  // detecção antiga o bastante para que seg (±Δ) nunca fique "no futuro"
  for (const [dt, ok] of [[0, true], [300, true], [301, false], [-300, true], [-301, false], [900, false]]){
    const seg = segT({}, {tCaptura: det.tCaptura - dt});                                       // idade ≤ 1500 em todos: só a compatibilidade decide
    const d = decT([D_()], {seg, deteccao: det});
    assert.equal(d.decisao, ok ? 'possivel_passagem_esquerda' : 'obstaculo_direita', 'Δ=' + dt);
    assert.equal(d.fontes.segmentacao.estado, ok ? 'ok' : 'incompativel');
    if (!ok){ assert.match(d.ausentes.join(' '), /incompatível/); assert.ok(d.limitacoes.includes('passagem_nao_avaliada')); assert.deepEqual(d.passagens, []); }
  }
  // sem instante de captura em uma das pontas, a compatibilidade é INVERIFICÁVEL: não se presume
  assert.equal(P.compativel({tCaptura: 1}, {}, 300).ok, false); assert.equal(P.compativel(undefined, {tCaptura: 1}, 300).ok, false);
  const semT = segT({}, {tCaptura: undefined, idadeMs: 50});
  assert.equal(decT([D_()], {seg: semT}).fontes.segmentacao.estado, 'incompativel'); assert.equal(decT([D_()], {seg: semT}).decisao, 'obstaculo_direita');
  assert.equal(decT([D_()], {seg: segT(), deteccao: detT({tCaptura: undefined, idadeMs: 50})}).decisao, 'obstaculo_direita');
});
test('[simulado] Cenário H: tarefa opcional adiada por lentidão deixa a passagem indeterminada, mas o alerta de obstáculo continua', async () => {
  const r = relogio(); let seg = null; const reg = [];
  const ag = criarAgendador(base(r, {intervalo: () => 20}));
  ag.registrar({nome: 'det', prio: 1, executar: async () => { r.avanca(60); return {tCap: r.now() - 60}; },
    aoConcluir: res => reg.push(P.decidirOrientacao({grupos: [D_()], agora: r.now(), deteccao: {estado: 'ok', origem: 'simulado', tCaptura: res.tCap}, seg}))});
  ag.registrar({nome: 'seg', prio: 2, opcional: true, executar: async () => ({estado: 'ok', origem: 'simulado', tCaptura: r.now(), cobertura: .95, regioes: {esquerda: BOA(), frente: BOA(), direita: BOA()}}), aoConcluir: res => { seg = res; }});
  ag.iniciar(); await ate(() => ag.snapshot().concluidos >= 14); const s = ag.snapshot(); ag.parar();
  assert.ok(s.tarefas.seg.adiadas >= 5, 'adiadas=' + s.tarefas.seg.adiadas);                    // o agendador adiou a tarefa opcional por lentidão
  assert.equal(reg[0].fontes.segmentacao.estado, 'indisponivel');                                // 1º ciclo: a segmentação ainda não existia
  assert.ok(reg.some(x => x.decisao === 'possivel_passagem_esquerda'), 'com evidência recente a alternativa existe');
  const fim = reg.slice(-4);
  for (const x of fim){ assert.equal(x.decisao, 'obstaculo_direita'); assert.deepEqual(x.passagens, []); assert.equal(x.fontes.segmentacao.estado, 'incompativel'); }   // sem dado atual compatível: indeterminada
  assert.ok(reg.every(x => x.regioes.direita === 'obstaculo'));                                  // o alerta independente do dado adiado nunca parou
});

// ---------- Estados do sistema e códigos de falha ----------
test('estadoAnalise: carregando, pronto, analisando, pausado, falha de carregamento, câmera indisponível, inferência expirada', () => {
  const e = P.estadoAnalise, base_ = {modeloEstado: 'pronto', running: true, paused: false, emCurso: false, ultimoErro: ''};
  assert.equal(e({modeloEstado: 'carregando', running: false}), 'carregando_modelo'); assert.equal(e({modeloEstado: 'erro', running: false}), 'falha_carregamento');
  assert.equal(e({modeloEstado: 'nao_carregado', running: false}), 'parado'); assert.equal(e({modeloEstado: 'pronto', running: false}), 'pronto');
  assert.equal(e(base_), 'pronto'); assert.equal(e({...base_, emCurso: true}), 'analisando'); assert.equal(e({...base_, paused: true}), 'pausado');
  assert.equal(e({...base_, ultimoErro: 'camera_indisponivel'}), 'camera_indisponivel'); assert.equal(e({...base_, ultimoErro: 'sem_quadros_novos'}), 'camera_indisponivel');
  assert.equal(e({...base_, ultimoErro: 'inferencia_expirada'}), 'inferencia_expirada'); assert.equal(e({...base_, ultimoErro: 'falha_inferencia'}), 'falha_na_analise');
});
test('agendador: cada falha recebe um código que separa as causas (inferência, expirada, câmera, sem quadros, callback)', async () => {
  const run = async (opts, reg, ateFn) => { const r = relogio(), cods = [], ag = criarAgendador(base(r, Object.assign({aoErro: e => cods.push(e.codigo)}, opts))); ag.registrar(reg(r)); ag.iniciar(); await ate(() => ateFn(cods)); const s = ag.snapshot(); ag.parar(); return {cods, s}; };
  let x = await run({}, () => ({nome: 'm', executar: async () => { throw new Error('boom'); }}), c => c.length >= 1); assert.equal(x.cods[0], 'falha_inferencia'); assert.ok(x.s.errosPorCodigo.falha_inferencia >= 1);
  x = await run({}, () => ({nome: 'm', executar: async () => 1, aoConcluir: () => { throw new Error('cb'); }}), c => c.length >= 1); assert.equal(x.cods[0], 'falha_callback');
  x = await run({verificar: () => ({erro: 'Sem imagem da câmera.'})}, () => ({nome: 'm', executar: async () => 1}), c => c.length >= 1); assert.equal(x.cods[0], 'camera_indisponivel');
  x = await run({verificar: () => ({ignorar: 'sem_quadro_novo'})}, r => ({nome: 'm', executar: async () => { r.avanca(5); }}), c => c.length >= 1); assert.equal(x.cods[0], 'sem_quadros_novos');
  const erros = [], ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 20, watchdogMs: 80, aoErro: e => erros.push(e)});
  let k = 0; ag.registrar({nome: 'm', executar: () => ++k === 1 ? new Promise(() => {}) : Promise.resolve(1)});
  ag.iniciar(); await ate(() => ag.snapshot().concluidos >= 2, 2000); const s = ag.snapshot(); ag.parar();
  assert.equal(erros.length, 1); assert.equal(erros[0].codigo, 'inferencia_expirada'); assert.match(erros[0].message, /travada/); assert.equal(s.expirados, 1); assert.equal(s.errosPorCodigo.inferencia_expirada, 1);   // expirada ≠ falha comum
  const dd = decT([D_()], {seg: segT(), deteccao: detT({estado: 'inferencia_expirada', motivo: erros[0].message})});
  assert.equal(dd.decisao, 'analise_insuficiente'); assert.ok(dd.limitacoes.includes('deteccao_inferencia_expirada'));
});

// ---------- Pausa, retomada e encerramento com resultados pendentes (REGRESSÃO dos defeitos a, c) ----------
test('agendador: falha tardia de geração encerrada/pausada não vira erro da sessão atual (defeito a)', async () => {
  for (const parada of ['parar', 'pausar']){
    const erros = [], ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 20, aoErro: e => erros.push(e.message)});
    ag.registrar({nome: 'm', executar: async () => { await sleep(60); throw new Error('tardio'); }});
    ag.iniciar(); await sleep(15); ag[parada](); await sleep(150);
    assert.deepEqual(erros, [], parada); assert.equal(ag.snapshot().erros, 0); assert.equal(ag.snapshot().descartados, 1); ag.parar();
  }
});
test('agendador: watchdog que dispara com a assistência PAUSADA só libera o ciclo, sem alarme, e a retomada funciona', async () => {
  const erros = []; let k = 0, ok = 0;
  const ag = criarAgendador({now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, intervalo: () => 20, watchdogMs: 80, aoErro: e => erros.push(e.message)});
  ag.registrar({nome: 'm', executar: () => ++k === 1 ? new Promise(() => {}) : Promise.resolve(1), aoConcluir: () => ok++});
  ag.iniciar(); await sleep(20); ag.pausar(); await sleep(200);                                  // watchdog (80 ms) dispara durante a pausa
  assert.deepEqual(erros, []); assert.equal(ag.snapshot().erros, 0);
  ag.retomar(); await ate(() => ok >= 2, 1500); ag.parar();                                       // a inferência travada não bloqueia a nova sessão
});
test('[simulado] app: falha tardia depois de ENCERRAR não altera orientação nem fala', async () => {
  const a = await montar({detectFalha: true, detectMs: 100, vals: {intervalo: 20}});
  await a.iniciar(); await sleep(30); a.encerrar(); await sleep(400);
  assert.equal(a.els.oDec, undefined, 'a orientação foi atualizada depois de encerrar'); assert.deepEqual(a.falas.filter(t => /^Atenção/.test(t)), []); assert.match(a.els.status.textContent, /encerrada/);
});
test('[simulado] app: resultado em andamento ao ENCERRAR é descartado: nada é falado depois', async () => {
  const a = await montar({script: [[cadC]], detectMs: 150, vals: {intervalo: 20}});
  await a.iniciar(); await sleep(40); a.encerrar(); const n = a.falas.length; await sleep(500);
  assert.equal(a.falas.length, n); assert.equal(a.falas[a.falas.length - 1], 'Assistência encerrada.'); assert.equal(a.els.oDec, undefined);
});
test('[simulado] app: ao RETOMAR, evidências de antes da pausa não sobrevivem (defeito c)', async () => {
  const sc = [[cadE]], a = await montar({script: sc, vals: {intervalo: 20}});
  try {
    await a.iniciar(); await sleep(400); assert.equal(a.els.oDec.textContent, 'obstaculo_esquerda');
    a.pausar(); await sleep(60); sc[0] = [];                                                        // a cena mudou durante a pausa
    let n = 0, visto = null; a.aoDetectar = () => { if (++n === 2) visto = a.els.oDec.textContent; };
    a.pausar(); await sleep(400);                                                                   // retoma
    assert.equal(visto, 'nenhum_objeto_reconhecido');                                               // 1 ciclo após retomar já reflete a cena nova, sem o obstáculo velho
    assert.equal(a.els.mEst.textContent === 'pausado', false);
  } finally { a.encerrar(); }
});

// ---------- Estabilização não mantém alternativa sem evidência (REGRESSÃO do defeito b) ----------
test('[simulado] estabilizador: alternativa cai NA HORA quando a evidência some, expira ou fica incompatível; só medição desfavorável tem histerese', () => {
  const novo = () => { const estab = P.criarEstabilizadorAlt(); const f = ex => decT([D_()], Object.assign({seg: segT(), estab}, ex)).decisao; return {estab, f}; };
  const liga = f => { assert.deepEqual([f(), f(), f()], ['obstaculo_direita', 'obstaculo_direita', 'possivel_passagem_esquerda']); };      // precisa de kOn = 3 ciclos confirmados
  let {f} = novo(); liga(f); assert.equal(f({seg: undefined}), 'obstaculo_direita', 'sem avaliação');
  ({f} = novo()); liga(f); assert.equal(f({seg: segT({}, {tCaptura: AGORA - 2000})}), 'obstaculo_direita', 'expirada');
  ({f} = novo()); liga(f); assert.equal(f({seg: segT({}, {tCaptura: AGORA - 1000})}), 'obstaculo_direita', 'incompatível');
  ({f} = novo()); liga(f); assert.equal(f({seg: segT({}, {estado: 'falha'})}), 'obstaculo_direita', 'falha da fonte');
  ({f} = novo()); liga(f); assert.equal(f({seg: segT({}, {cobertura: .1})}), 'obstaculo_direita', 'incompleta');
  const n = novo(); liga(n.f);                                                                      // detecção inválida no meio: esquece tudo, religar exige kOn ciclos de novo
  assert.equal(decT([D_()], {estab: n.estab, deteccao: detT({estado: 'falha'})}).decisao, 'analise_insuficiente');
  assert.deepEqual([n.f(), n.f(), n.f()], ['obstaculo_direita', 'obstaculo_direita', 'possivel_passagem_esquerda']);
  // medição VÁLIDA e desfavorável: histerese de kOff = 3 ciclos (decisão de projeto herdada, para não piscar); cai no 3º
  const h = novo(); liga(h.f); const ruim = () => h.f({seg: segT({esquerda: RUIM})});
  assert.deepEqual([ruim(), ruim(), ruim()], ['possivel_passagem_esquerda', 'possivel_passagem_esquerda', 'obstaculo_direita']);
  // obstáculo detectado na região derruba imediatamente
  const o = novo(); liga(o.f); assert.equal(decT([D_(), E_()], {seg: segT(), estab: o.estab}).passagens.includes('esquerda'), false);
});

// ---------- Lados confirmados ----------
test('lados: só ficam confirmados se escolhidos pelo usuário ou informados pelo navegador; senão nenhuma alternativa lateral (o centro vale)', () => {
  const c = P.ladosConfirmados;
  assert.deepEqual([c('auto', 'user'), c('auto', 'environment'), c('auto', ''), c('auto', 'left'), c('normal', ''), c('invertido', '')], [true, true, false, false, true, true]);
  const lados = {confirmado: false};
  let {d, p} = falaT([D_()], {seg: segT(), lados});
  assert.equal(d.decisao, 'obstaculo_direita'); assert.deepEqual(d.passagens, []); assert.equal(d.regioes.esquerda, 'desconhecida'); assert.ok(d.limitacoes.includes('orientacao_dos_lados_nao_confirmada'));
  assert.equal(p.texto, 'Cadeira à direita.'); assert.ok(d.ausentes.some(a => /lados/.test(a)));                         // o obstáculo continua informado
  ({d} = falaT([E_(), D_()], {seg: segT(), lados})); assert.equal(d.decisao, 'possivel_passagem_centro');               // espelhar não muda o centro
  ({d} = falaT([F_()], {seg: segT(), lados})); assert.equal(d.decisao, 'passagem_nao_confirmada');
  ({d} = falaT([D_()], {seg: segT(), lados: {confirmado: true}})); assert.equal(d.decisao, 'possivel_passagem_esquerda');
  ({d, p} = falaT([D_()], {modo: 'pista', lados}));                                                                          // modo pista também não indica lateral sem lados confirmados
  assert.equal(d.decisao, 'analise_insuficiente'); assert.deepEqual(d.passagens, []);
});
test('[simulado] a divisão em zonas da DETECÇÃO e a da AVALIAÇÃO DE PISO concordam em todos os lados, normal e invertido', () => {
  const caixas = [[.1, 'esquerda'], [.25, 'esquerda'], [.4, 'frente'], [.5, 'frente'], [.75, 'direita'], [.9, 'direita']];
  for (const inv of [false, true]) for (const [cx, zRaw] of caixas){
    const lt = (x, y, w, h) => ({x, y, w, h}), caixa = lt(cx - .05, .3, .1, .5);
    const esperado = P.ladoUsuario(zRaw, inv);
    assert.equal(P.zonaDe([caixa.x * W, caixa.y * H, caixa.w * W, caixa.h * H], W, inv), esperado, `zonaDe cx=${cx} inv=${inv}`);
    const r = P.avaliarPassagemPorCor(imagem(() => CHAO), [caixa], inv), menor = ['esquerda', 'frente', 'direita'].reduce((m, z) => r.regioes[z].livre < r.regioes[m].livre ? z : m);
    assert.equal(menor, esperado, `piso cx=${cx} inv=${inv}`);                                  // a região "menos livre" é a mesma que a detecção chamaria de ocupada
  }
});

// ---------- Fontes externas (segmentação/profundidade): contrato, estado e limites ----------
test('validarFonteExterna: exige estado ok, origem, instante de captura e resultado completo; o que faltar vira "incompleto"', () => {
  const v = P.validarFonteExterna, ok = {estado: 'ok', origem: 'modelo-x', tCaptura: 5, completo: true};
  assert.equal(v(ok).estado, 'ok'); assert.equal(v(null).estado, 'incompleto'); assert.equal(v('x').estado, 'incompleto');
  assert.equal(v({...ok, tCaptura: undefined}).estado, 'incompleto'); assert.match(v({...ok, tCaptura: undefined}).motivo, /tCaptura/);
  assert.equal(v({...ok, origem: ''}).estado, 'incompleto'); assert.equal(v({...ok, completo: false}).estado, 'incompleto');
  assert.equal(v({...ok, estado: undefined}).estado, 'incompleto'); assert.equal(v({...ok, estado: 'falha', motivo: 'oom'}).estado, 'falha');
});
test('[simulado] Cenário 11: segmentação semântica NÃO implementada → estado "indisponivel", sem fingir; fonte externa incompleta não é usada', async () => {
  const a = await montar({script: [[cadD]], vals: {intervalo: 20}});
  try {
    const V = a.win.VisioIndustria, f0 = V.estadoFontes();
    assert.equal(f0.segmentacao.estado, 'indisponivel'); assert.match(f0.segmentacao.motivo, /nenhum modelo/); assert.equal(f0.profundidade.estado, 'indisponivel');
    await a.iniciar(); await sleep(600);
    const d0 = V.decisaoAtual(); assert.equal(d0.decisao, 'obstaculo_direita'); assert.equal(d0.fontes.segmentacao.estado, 'indisponivel'); assert.ok(d0.limitacoes.includes('passagem_nao_avaliada_pelo_sistema'));
    V.receberSegmentacao({estado: 'ok', origem: 'modelo-x', cobertura: 1, regioes: {}});          // sem tCaptura
    assert.equal(V.estadoFontes().segmentacao.estado, 'incompleto');                               // reportado como é, nunca como "ok"
    await sleep(400); assert.equal(V.decisaoAtual().decisao, 'obstaculo_direita'); assert.deepEqual(V.decisaoAtual().passagens, []);
    assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']);
  } finally { a.encerrar(); }
});
test('[simulado] app: segmentação externa de outro instante (incompatível) não é combinada; do mesmo instante, é', async () => {
  let a = await montar({script: [[cadD]], vals: {intervalo: 20}});
  a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim({}, {tCaptura: performance.now() - 5000, idadeMs: undefined}));
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']); assert.equal(a.win.VisioIndustria.decisaoAtual().fontes.segmentacao.estado, 'desatualizado');   // 5 s: expirada
  a = await montar({script: [[cadD]], vals: {intervalo: 20}});
  a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim({}, {tCaptura: performance.now() - 1000, idadeMs: undefined}));          // recente (1 s) mas de OUTRO quadro
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']); assert.equal(a.win.VisioIndustria.decisaoAtual().fontes.segmentacao.estado, 'incompativel');
  a = await montar({script: [[cadD]], vals: {intervalo: 20}});
  a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim({}, {idadeMs: undefined}));                                              // mesmo instante
  try { await a.iniciar(); await sleep(2000); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à direita. Possível passagem à esquerda.']);
});
test('configurarLimites: valida tudo-ou-nada, rejeita chaves desconhecidas/kOn/kOff/negativos e altera de fato a compatibilidade', () => {
  const antes = {...P.LIM};
  try {
    for (const ruim of [{xyz: 1}, {kOn: 2}, {compatMaxMs: -1}, {compatMaxMs: NaN}, {compatMaxMs: 500, xyz: 1}, {}]){ const r = P.configurarLimites(ruim); assert.equal(r.aplicado, false, JSON.stringify(ruim)); assert.deepEqual(P.LIM, antes); }
    const seg = segT({}, {tCaptura: AGORA - 80 - 1000});
    assert.equal(decT([D_()], {seg}).decisao, 'obstaculo_direita');                                  // Δ = 1000 ms > 300
    const r = P.configurarLimites({compatMaxMs: 1200}); assert.equal(r.aplicado, true); assert.equal(r.limites.compatMaxMs, 1200);
    assert.equal(decT([D_()], {seg}).decisao, 'possivel_passagem_esquerda');                         // o limite configurável muda o resultado
  } finally { Object.assign(P.LIM, antes); }
});

// ---------- Quadro de origem: captura dos pixels e dimensões (REGRESSÃO do defeito d) ----------
test('[simulado] app: pixels da avaliação de piso são capturados junto com o quadro da inferência e valem o MESMO instante das caixas (defeito d)', async () => {
  const tQuadro = [], ini = [];
  const a = await montar({script: [[cadC]], detectMs: 80, vals: {intervalo: 20, passagem: 'ligada'}, quadro: () => { tQuadro.push(performance.now()); return imagem(() => CHAO); }});
  a.aoDetectar = t => ini.push(t);
  try { await a.iniciar(); await sleep(700); } finally { a.encerrar(); }
  assert.ok(tQuadro.length >= 2 && ini.length >= 2);
  for (let i = 0; i < Math.min(tQuadro.length, ini.length, 3); i++) assert.ok(Math.abs(tQuadro[i] - ini[i]) < 30, `ciclo ${i}: pixels ${(tQuadro[i] - ini[i]).toFixed(0)} ms do início da inferência (detectMs = 80)`);
  const f = a.win.VisioIndustria.decisaoAtual().fontes; assert.equal(f.segmentacao.estado, 'ok'); assert.equal(f.segmentacao.deltaMs, 0); assert.equal(f.segmentacao.origem, 'heuristica_cor_piso');
});
test('[simulado] app: as dimensões usadas nas zonas são as do QUADRO analisado, não as do vídeo no instante do alerta', async () => {
  const a = await montar({script: [[d('chair', [280, 150, 80, 150])]], vals: {intervalo: 20, persist: 1}});
  let n = 0, visto = null; a.aoDetectar = () => { if (++n === 1) a.els.video.videoWidth = 1000; if (n === 2){ visto = a.win.VisioIndustria.decisaoAtual(); a.els.video.videoWidth = 640; } };   // a largura "muda" durante a 1ª inferência (ex.: rotação)
  try { await a.iniciar(); await sleep(300); } finally { a.encerrar(); }
  assert.deepEqual([visto.obstaculos.frente.length, visto.obstaculos.esquerda.length], [1, 0]);               // decisão do 1º ciclo usa W=640 (do quadro); com W=1000 cairia à esquerda
});
test('[simulado] app: lados não confirmados (câmera sem facingMode, seleção automática) só informam o obstáculo; com facingMode ou escolha explícita a alternativa sai', async () => {
  const rod = async (vals, facing) => { const a = await montar({script: [[cadD]], vals: Object.assign({intervalo: 20}, vals), facing}); a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim({}, {idadeMs: undefined}));
    try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); } return a; };
  let a = await rod({lados: 'auto'}, ''); assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']); assert.match(a.els.oLados.textContent, /NÃO confirmados/); assert.ok(a.win.VisioIndustria.decisaoAtual().limitacoes.includes('orientacao_dos_lados_nao_confirmada'));
  for (const [vals, facing] of [[{lados: 'auto'}, 'environment'], [{lados: 'normal'}, ''], [{lados: 'invertido'}, '']]){
    a = await rod(vals, facing);   // invertido: a caixa à direita da IMAGEM é obstáculo à ESQUERDA do usuário, e a alternativa passa a ser a direita dele
    assert.deepEqual(naoInicio(a.falas), [vals.lados === 'invertido' ? 'Obstáculo à esquerda. Possível passagem à direita.' : 'Obstáculo à direita. Possível passagem à esquerda.'], JSON.stringify(vals));
  }
});

// ---------- Oscilação, estado na interface, preservação ----------
test('[simulado] app: obstáculo que oscila entre esquerda e direita a cada ciclo não gera alternância de recomendações nem fala em loop', async () => {
  const a = await montar({script: [[cadE], [cadD]], vals: {intervalo: 20}}); a.aoDetectar = () => a.win.VisioIndustria.receberSegmentacao(segSim({}, {idadeMs: undefined}));
  try { await a.iniciar(); await sleep(2000); } finally { a.encerrar(); }
  const f = naoInicio(a.falas); assert.ok(f.length <= 2, 'falas: ' + JSON.stringify(f)); assert.ok(f.every(t => !/Possível passagem à (esquerda|direita)|Passagens possíveis/.test(t)), JSON.stringify(f));   // nenhuma alternativa LATERAL enquanto há objeto aparecendo nos dois lados
});
test('[simulado] app: o painel mostra o estado da análise (falha de carregamento, pausado) e as fontes/regiões da decisão', async () => {
  const b = await montar({loadFalha: true}); await b.iniciar(); await sleep(150); assert.match(b.els.mEst.textContent, /falha ao carregar/); assert.equal(b.calls(), 0);
  const a = await montar({script: [[cadD]], vals: {intervalo: 20}});
  try {
    await a.iniciar(); await sleep(700); assert.match(a.els.oFontes.textContent, /detecção ok · passagem indisponivel · profundidade indisponivel/); assert.match(a.els.oReg.textContent, /E: desconhecida · F: desconhecida · D: obstaculo/);
    a.pausar(); await sleep(50); assert.match(a.els.status.textContent, /pausada/);
  } finally { a.encerrar(); }
});
test('preservação: modo padrão é o inicial; pista continua disponível; CSVs, painel e controles anteriores continuam no HTML; nenhuma rede nova', () => {
  const h = fs.readFileSync(HTML, 'utf8');
  assert.match(h, /<select id="modo"><option value="padrao">/); assert.match(h, /<option value="pista">Pista controlada \(experimental\)/);
  assert.match(SC, /hora;ciclo;resultado;erro;inferencia_coco_ssd_ms;ciclo_total_ms;modelo_base;fps_camera;codigo_erro/); assert.match(SC, /hora;objetos_e_zonas;latencia_ms;mensagem;decisao/);
  for (const id of ['btnIniciar', 'btnPausar', 'btnEncerrar', 'btnTeste', 'btnCsv', 'btnPerf', 'mBackend', 'mCarga', 'mInf', 'mCic', 'mFps', 'mCam', 'mFr', 'mIgn', 'mErr', 'mAtr', 'mDesc', 'mLat', 'mAl', 'mSup', 'mFa', 'mExp', 'mEst']) assert.ok(h.includes('id="' + id + '"'), id);
  for (const js of [SC, NUCLEO_SRC])
    assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|serviceWorker/);       // sem transmissão nem armazenamento de imagens/dados (análise estática do código do app)
  assert.doesNotMatch(h, /<script>/, 'script embutido no HTML: a política de segurança (CSP) não permite');
  // Só as duas bibliotecas fixadas (com SRI) vêm de fora; o resto é da mesma origem.
  assert.deepEqual(h.match(/<script src="[^"]+"/g), ['<script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"', '<script src="https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js"',
    '<script src="js/nucleo.js"', '<script src="js/app.js"', '<script src="js/pwa.js"']);
  for (const tag of h.match(/<script src="https:[^>]+>/g)) assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]{64}" crossorigin="anonymous"/, tag);
});

// ---------- INVARIANTES (varredura combinatória: todas as combinações abaixo, nenhuma amostragem) ----------
test('[simulado] INVARIANTES: dados insuficientes/obsoletos/incompatíveis/indisponíveis nunca permitem direção; nenhuma detecção nunca implica caminho livre; alternativa nunca é garantia', () => {
  const grupos = [[], [E_()], [F_()], [D_()], [E_(), F_()], [F_(), D_()], [E_(), D_()], [E_(), F_(), D_()]];
  const dets = [['ok', detT()], ['falha', detT({estado: 'falha'})], ['incompleto', detT({estado: 'incompleto'})], ['carregando', detT({estado: 'carregando'})], ['falha_carregamento', detT({estado: 'falha_carregamento'})],
                ['indisponivel', detT({estado: 'indisponivel'})], ['inferencia_expirada', detT({estado: 'inferencia_expirada'})], ['camera_indisponivel', detT({estado: 'camera_indisponivel'})],
                ['desatualizada', detT({tCaptura: AGORA - 5000})], ['sem_tempo', {estado: 'ok', origem: 'simulado'}]];
  const segs = [['valida', segT(), true], ['ausente', undefined, false], ['falha', segT({}, {estado: 'falha'}), false], ['incompleta', segT({}, {estado: 'incompleto'}), false], ['cobertura', segT({}, {cobertura: .1}), false],
                ['expirada', segT({}, {tCaptura: AGORA - 2000}), false], ['incompativel', segT({}, {tCaptura: AGORA - 80 - 1000}), false], ['sem_tempo', segT({}, {tCaptura: undefined}), false], ['indisponivel', {estado: 'indisponivel'}, false]];
  let n = 0;
  for (const gs of grupos) for (const [dn, det] of dets) for (const [sn, seg, segOk] of segs) for (const lados of [undefined, {confirmado: false}]) for (const modo of ['padrao', 'pista']){
    const detOk = dn === 'ok', r = falaT(gs, {seg, deteccao: det, lados, modo}), {d, p} = r, rot = `${gs.length}obs/${dn}/${sn}/${lados ? 'lados?' : 'lados'}/${modo}`; n++;
    assert.equal(d.permiteDirecao, d.passagens.length > 0, rot);
    if (!detOk){ assert.equal(d.decisao, 'analise_insuficiente', rot); assert.deepEqual(d.passagens, [], rot); assert.ok(Object.values(d.regioes).every(x => x === 'desconhecida'), rot); }   // falha de modelo nunca é evidência positiva
    if (detOk && modo === 'padrao' && !segOk){ assert.deepEqual(d.passagens, [], rot); assert.notEqual(d.fontes.segmentacao.estado, 'ok', rot); assert.ok(Object.entries(d.regioes).every(([z, x]) => x === 'obstaculo' || x === 'desconhecida'), rot); }   // fonte inutilizável nunca vira válida
    if (!gs.length) assert.deepEqual(d.passagens, [], rot);                                         // nenhuma detecção ⇒ nunca direção
    if (gs.length === 3) assert.deepEqual(d.passagens, [], rot);                                    // tudo obstruído ⇒ nunca direção
    for (const z of d.passagens){ assert.ok(!gs.some(g => g.z === z), rot); if (modo === 'padrao') assert.equal(d.regioes[z], 'avaliada_favoravel', rot); }   // alternativa só onde há evidência favorável e sem obstáculo
    if (lados) for (const z of d.passagens) assert.equal(z, 'frente', rot);                          // lados não confirmados: só o centro
    assert.doesNotMatch(semNenhum(p.texto), AFIRMATIVA, rot + ': ' + p.texto);                      // jamais "livre", "seguro" ou garantia
  }
  assert.equal(n, grupos.length * dets.length * segs.length * 2 * 2);                                 // a varredura percorreu TODAS as combinações
});

test('[simulado] detecção ainda não confirmada (persistência) veta alternativa na região, sem virar obstáculo nem análise insuficiente', () => {
  let d = decT([E_()], {seg: segT(), pendentes: [{z: 'direita'}]});
  assert.equal(d.decisao, 'obstaculo_esquerda'); assert.deepEqual(d.passagens, []); assert.equal(d.regioes.direita, 'desconhecida'); assert.match(d.motivos.join(' '), /ainda não confirmada/);
  d = decT([E_()], {seg: segT(), pendentes: [{z: 'frente'}]});                                  // pendente no centro não atrapalha a lateral livre
  assert.equal(d.decisao, 'possivel_passagem_direita');
  d = decT([], {pendentes: [{z: 'frente'}]}); assert.equal(d.decisao, 'nenhum_objeto_reconhecido');   // não aciona o ramo "baixa confiança"
  const estab = P.criarEstabilizadorAlt(); const f = ex => decT([E_()], Object.assign({seg: segT(), estab}, ex)).decisao;
  assert.deepEqual([f(), f(), f({pendentes: [{z: 'direita'}]}), f(), f()], ['obstaculo_esquerda', 'obstaculo_esquerda', 'obstaculo_esquerda', 'obstaculo_esquerda', 'obstaculo_esquerda']);   // o pendente zera a contagem de confirmação
  assert.equal(f(), 'possivel_passagem_direita');
  const e2 = P.criarEstabilizadorAlt(), g = ex => decT([E_()], Object.assign({seg: segT(), estab: e2}, ex)).decisao;
  assert.deepEqual([g(), g(), g()], ['obstaculo_esquerda', 'obstaculo_esquerda', 'possivel_passagem_direita']);          // passagem JÁ ligada pelo estabilizador...
  assert.equal(g({pendentes: [{z: 'direita'}]}), 'obstaculo_esquerda');                                                    // ...cai NA HORA quando um objeto começa a aparecer nela (sem histerese)
});

// =====================================================================================================================
// SEGMENTAÇÃO: ADAPTADOR DE MÁSCARA E PONTO DE INTEGRAÇÃO. SIMULADO: máscaras e "segmentador" são sintéticos e escritos à mão.
// Provam que o ADAPTADOR e a INTEGRAÇÃO fazem o que descrevem (contrato, orientação, falhas, calibração, agendamento).
// NÃO provam que algum modelo real (DeepLab/ADE20K ou outro) reconheça chão, parede ou porta numa fábrica, nem quanto custa no celular.
// =====================================================================================================================
const mascara = (fn, w = 60, h = 48) => { const m = new Uint8Array(w*h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y*w + x] = fn(x, y); return {mascara: m, w, h}; };
const PISO = 0, PAREDE = 1, PORTA = 2;                                    // ids arbitrários do teste (mapeamento de classes é do integrador)
const opcM = (extra = {}) => Object.assign({piso: [PISO], confianca: .8}, extra);

test('[simulado] adaptador de máscara: chão livre → três regiões livres, contínuas e largas; só as classes de piso contam como livres', () => {
  let r = P.regioesDeMascara(mascara(() => PISO), opcM());
  assert.equal(r.estado, 'ok'); assert.equal(r.metodo, 'mascara_de_classes'); assert.equal(r.cobertura, 1);
  for (const z of ['esquerda', 'frente', 'direita']) assert.deepEqual([r.regioes[z].livre, r.regioes[z].continuidade, r.regioes[z].larguraRel, r.regioes[z].confianca], [1, 1, 1, .8]);
  r = P.regioesDeMascara(mascara((x, y) => x >= 40 && y >= 24 ? PAREDE : PISO), opcM());               // parede no terço direito, metade inferior
  assert.ok(r.regioes.direita.livre === 0 && r.regioes.direita.continuidade === 0 && r.regioes.esquerda.livre === 1);
  r = P.regioesDeMascara(mascara((x, y) => x >= 20 && x < 40 && y >= 38 && y < 42 ? PORTA : PISO), opcM());   // faixa de outra classe perto da base, cortando o caminho: livre alto, continuidade baixa
  assert.ok(r.regioes.frente.livre > .7 && r.regioes.frente.continuidade === 0);
  r = P.regioesDeMascara(mascara(() => 7), opcM()); assert.equal(r.regioes.frente.livre, 0);                // classe desconhecida NÃO é piso
  r = P.regioesDeMascara(mascara(() => PORTA), opcM({piso: [PISO, PORTA]})); assert.equal(r.regioes.frente.livre, 1);   // vários ids de piso
});
test('[simulado] adaptador: orientação invertida troca os lados do usuário; pixels ignorados reduzem a cobertura; entradas inválidas viram "incompleto"', () => {
  const m = mascara((x, y) => x >= 40 && y >= 24 ? PAREDE : PISO);
  assert.ok(P.regioesDeMascara(m, opcM()).regioes.direita.livre === 0);
  const inv = P.regioesDeMascara(m, opcM({invertido: true})).regioes; assert.ok(inv.esquerda.livre === 0 && inv.direita.livre === 1);   // parede na direita da IMAGEM = esquerda do usuário
  const ig = P.regioesDeMascara(mascara((x, y) => y >= 24 && x % 2 ? 255 : PISO), opcM()); assert.equal(ig.cobertura, .5);
  assert.ok(ig.regioes.frente.livre < .6);                                                                  // ignorado nunca conta como livre
  for (const [m_, o, re] of [[null, opcM(), /inválida/], [{mascara: new Uint8Array(10), w: 60, h: 48}, opcM(), /tamanho/], [mascara(() => 0), {confianca: .8}, /classe de piso/], [mascara(() => 0, 60, 1), opcM({topo: 1}), /vazia/]]){
    const r = P.regioesDeMascara(m_, o); assert.equal(r.estado, 'incompleto'); assert.match(r.motivo, re);
  }
  assert.equal(P.regioesDeMascara(mascara(() => 0), opcM({confianca: 5})).regioes.frente.confianca, .9);     // limitada a 0,9
  assert.equal(P.regioesDeMascara(mascara(() => 0), {piso: [0]}).regioes.frente.confianca, 0);              // sem calibração: 0
});
test('[simulado] máscara → decisão: com calibração vira alternativa possível; SEM calibração (confiança 0) a decisão fica "desconhecida" e nada é indicado', () => {
  const seg = (conf, extra = {}) => Object.assign({origem: 'fake', tCaptura: AGORA - 80}, P.regioesDeMascara(mascara(() => PISO), opcM({confianca: conf})), extra);
  let d = decT([D_()], {seg: seg(.8)}); assert.equal(d.decisao, 'possivel_passagem_esquerda'); assert.equal(d.fontes.segmentacao.origem, 'fake');
  d = decT([D_()], {seg: seg(0)}); assert.equal(d.decisao, 'obstaculo_direita'); assert.deepEqual(d.passagens, []); assert.equal(d.regioes.esquerda, 'desconhecida'); assert.match(d.motivos.join(' '), /baixa confiança/);
  d = decT([D_()], {seg: seg(.8, {cobertura: .3})}); assert.equal(d.decisao, 'obstaculo_direita');                  // cobertura baixa: incompleta
  d = decT([], {seg: seg(.8)}); assert.deepEqual(d.passagens, []);                                                // Cenário E vale para segmentação também
});

// ---------- registrarSegmentador (integração real com o agendador do app; segmentador FALSO) ----------
const fakeSeg = (extra = {}) => Object.assign({origem: 'fake', confianca: .8, rotulos: {piso: [PISO]}, executar: async () => mascara(() => PISO, 64, 48)}, extra);
test('[simulado] registrarSegmentador valida o contrato e aceita um único segmentador', async () => {
  const a = await montar({}), V = a.win.VisioIndustria;
  for (const ruim of [null, {}, fakeSeg({origem: ''}), fakeSeg({rotulos: {}}), fakeSeg({rotulos: {piso: []}}), fakeSeg({confianca: undefined}), fakeSeg({executar: 1})]) assert.throws(() => V.registrarSegmentador(ruim), /inválido/);
  assert.equal(V.estadoFontes().segmentacao.registrado, false);
  V.registrarSegmentador(fakeSeg()); assert.equal(V.estadoFontes().segmentacao.registrado, true); assert.match(V.estadoFontes().segmentacao.motivo, /ainda sem resultado/);
  assert.throws(() => V.registrarSegmentador(fakeSeg()), /já existe/);
});
test('[simulado] app + segmentador calibrado: obstáculo à direita com chão segmentado à esquerda → "possível passagem", e o painel mostra a segmentação', async () => {
  const a = await montar({script: [[cadD]], vals: {intervalo: 20}}); a.win.VisioIndustria.registrarSegmentador(fakeSeg());
  try { await a.iniciar(); await sleep(2000); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Obstáculo à direita. Possível passagem à esquerda.']);
  const f = a.win.VisioIndustria.decisaoAtual().fontes.segmentacao; assert.equal(f.estado, 'ok'); assert.equal(f.origem, 'fake'); assert.ok(f.deltaMs < 50);
  assert.match(a.els.mSeg.textContent, /ms · méd/);
});
test('[simulado] app + segmentador SEM calibração de campo (confiança 0): nunca autoriza alternativa; só informa o obstáculo', async () => {
  const a = await montar({script: [[cadD]], vals: {intervalo: 20}}); a.win.VisioIndustria.registrarSegmentador(fakeSeg({confianca: 0}));
  try { await a.iniciar(); await sleep(1500); } finally { a.encerrar(); }
  assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']); assert.equal(a.win.VisioIndustria.decisaoAtual().regioes.esquerda, 'desconhecida');
});
test('[simulado] segmentador que FALHA, devolve lixo ou demora demais não derruba os alertas de obstáculo nem vira passagem', async () => {
  const casos = [['falha', fakeSeg({executar: async () => { throw new Error('oom'); }}), 'falha'],
                 ['lixo', fakeSeg({executar: async () => ({mascara: new Uint8Array(3), w: 64, h: 48})}), 'incompleto'],
                 ['travado', fakeSeg({executar: () => new Promise(() => {}), timeoutMs: 40}), 'inferencia_expirada']];
  for (const [nome, seg, estado] of casos){
    const a = await montar({script: [[cadD]], vals: {intervalo: 20}}); a.win.VisioIndustria.registrarSegmentador(seg);
    try { await a.iniciar(); await sleep(1800); } finally { a.encerrar(); }
    assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.'], nome); assert.equal(a.win.VisioIndustria.estadoFontes().segmentacao.estado, estado, nome);
    assert.equal(+a.els.mErr.textContent, 0, nome); assert.ok(+a.els.mFr.textContent >= 5, nome + ': ciclos de detecção continuaram');
  }
});
test('[simulado] segmentador a cada 3 ciclos: nos ciclos sem resultado novo o dado é incompatível com a detecção e NÃO é combinado', async () => {
  const a = await montar({script: [[cadD]], vals: {intervalo: 20}}); const V = a.win.VisioIndustria;
  V.configurarLimites({compatMaxMs: 15}); V.registrarSegmentador(fakeSeg({cadaN: 3}));
  const vistos = new Set(); a.aoDetectar = () => { const d = V.decisaoAtual(); if (d) vistos.add(d.fontes.segmentacao.estado); };
  try { await a.iniciar(); await sleep(2000); } finally { a.encerrar(); }
  assert.ok(vistos.has('incompativel'), JSON.stringify([...vistos])); assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']);   // nunca atingiu 3 ciclos válidos seguidos
});
test('[simulado] segmentador é tarefa OPCIONAL: com a detecção lenta ele é adiado (e a passagem fica indeterminada), e a detecção segue', async () => {
  const a = await montar({script: [[cadD]], detectMs: 80, vals: {intervalo: 20}}); const V = a.win.VisioIndustria; V.configurarLimites({compatMaxMs: 50}); V.registrarSegmentador(fakeSeg());   // limite pequeno: com o provisório (300 ms) um resultado de 1-2 ciclos atrás ainda seria combinado, por projeto
  try { await a.iniciar(); await sleep(2500); } finally { a.encerrar(); }
  assert.match(a.els.mSeg.textContent, /adiada \d+×/);                                              // o agendador adiou a tarefa opcional por lentidão
  assert.deepEqual(naoInicio(a.falas), ['Cadeira à direita.']);                                      // sem dado atual e compatível: nenhuma alternativa
  assert.ok(['incompativel', 'desatualizado'].includes(V.decisaoAtual().fontes.segmentacao.estado)); assert.ok(+a.els.mFr.textContent >= 5);
});
