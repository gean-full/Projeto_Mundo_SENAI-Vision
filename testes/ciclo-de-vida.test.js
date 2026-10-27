'use strict';
/*
 * Ciclo de vida e concorrência do app inteiro (js/app.js) com câmera, modelo e voz SIMULADOS.
 * Permissão da câmera e carga do modelo usam promessas controladas pelo teste, então a ordem dos eventos é determinística.
 * Não validam câmera real, navegador real nem precisão do modelo.
 */
const test = require('node:test'), assert = require('node:assert/strict');
const { montar, d, sleep, adiada } = require('./apoio.js');
const ate = async (cond, ms = 2000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(2); assert.ok(cond(), 'condição não atingida a tempo'); };
const ativadas = a => a.falas.filter(t => /^Assistência ativada/.test(t)).length;
const cadD = d('chair', [540, 150, 80, 150]);

test('início repetido (cliques e Espaço) durante o pedido de permissão abre UMA câmera e UMA sessão', async () => {
  const p = adiada(); const a = await montar({gum: (c, novo) => p.promessa.then(novo)});
  const iniciais = [a.iniciar(), a.iniciar(), a.iniciar()]; a.disparar('keydown', {code: 'Space', target: {tagName: 'BODY'}});
  assert.equal(a.cont.gum, 1, 'getUserMedia chamado mais de uma vez'); assert.equal(a.estado(), 'solicitando_camera');
  assert.equal(a.els.btnIniciar.disabled, true); assert.equal(a.els.btnIniciar.textContent, 'Iniciando…'); assert.equal(a.els.btnEncerrar.disabled, false);
  p.resolve(); await Promise.all(iniciais); await ate(() => a.estado() === 'ativo');
  try {
    assert.equal(a.cont.trilhas, 1); assert.equal(a.cont.cargas, 1); assert.equal(ativadas(a), 1);
    await sleep(200); assert.equal(a.maxEm(), 1);
  } finally { a.encerrar(); }
  assert.equal(a.cont.paradas, 1, 'câmera não liberada ao encerrar');
});

test('encerrar enquanto o navegador pede permissão: a câmera que chegar depois é liberada na hora e nada roda', async () => {
  const p = adiada(); const a = await montar({gum: (c, novo) => p.promessa.then(novo)});
  const ini = a.iniciar(); a.encerrar();
  assert.equal(a.estado(), 'ocioso'); assert.match(a.els.status.textContent, /cancelado/);
  p.resolve(); await ini; await sleep(100);
  assert.equal(a.cont.trilhas, 1); assert.equal(a.cont.paradas, 1, 'câmera tardia ficou aberta'); assert.equal(a.cont.cargas, 0); assert.equal(a.calls(), 0);
  assert.equal(ativadas(a), 0); assert.equal(a.estado(), 'ocioso');
});

test('encerrar durante a carga do modelo: a carga tardia não ressuscita a sessão; o modelo fica pronto para a próxima', async () => {
  const p = adiada(); let modelo; const a = await montar({load: (o, m) => { modelo = m; return p.promessa.then(() => m); }});
  const ini = a.iniciar(); await ate(() => a.estado() === 'carregando_modelo');
  a.encerrar(); assert.equal(a.cont.paradas, 1, 'câmera não liberada ao cancelar');
  p.resolve(); await ini; await sleep(120);
  assert.equal(a.estado(), 'ocioso'); assert.equal(a.calls(), 0, 'inferência rodou numa sessão encerrada'); assert.equal(ativadas(a), 0);
  assert.match(a.els.mModelo.textContent, /^pronto/);
  await a.iniciar(); try { assert.equal(a.estado(), 'ativo'); assert.equal(a.cont.cargas, 1, 'modelo recarregado sem necessidade'); await ate(() => a.calls() > 0); }
  finally { a.encerrar(); }
  assert.ok(modelo);
});

test('permissão negada: estado "câmera indisponível", mensagem acionável, nada aberto; tentar de novo funciona', async () => {
  let negar = true;
  const a = await montar({gum: async (c, novo) => { if (negar) throw Object.assign(new Error('Permission denied'), {name: 'NotAllowedError'}); return novo(); }});
  await a.iniciar();
  assert.equal(a.estado(), 'camera_indisponivel'); assert.match(a.els.status.textContent, /^Erro: Permissão da câmera negada/);
  assert.doesNotMatch(a.els.status.textContent, /Permission denied/); assert.equal(a.els.btnIniciar.disabled, false); assert.equal(a.els.btnEncerrar.disabled, true);
  assert.equal(a.cont.trilhas, 0); assert.equal(a.calls(), 0); assert.equal(+a.els.mFa.textContent, 1);
  assert.deepEqual(a.falas, ['Atenção: não foi possível iniciar a análise do ambiente.']);
  negar = false; await a.iniciar(); try { assert.equal(a.estado(), 'ativo'); } finally { a.encerrar(); }
});

test('câmera escolhida indisponível (OverconstrainedError) e câmera em uso (NotReadableError) têm mensagens próprias', async () => {
  for (const [name, re] of [['OverconstrainedError', /câmera escolhida não está disponível/], ['NotReadableError', /em uso por outro aplicativo/]]){
    const a = await montar({gum: async () => { throw Object.assign(new Error('x'), {name}); }}); await a.iniciar();
    assert.match(a.els.status.textContent, re); assert.equal(a.estado(), 'camera_indisponivel');
  }
});

test('falha na carga do modelo: "modelo indisponível", câmera liberada, nada roda', async () => {
  const a = await montar({loadFalha: true}); await a.iniciar();
  assert.equal(a.estado(), 'modelo_indisponivel'); assert.match(a.els.status.textContent, /^Erro: Não foi possível carregar o modelo/);
  assert.equal(a.cont.trilhas, 1); assert.equal(a.cont.paradas, 1); assert.equal(a.calls(), 0); assert.match(a.els.mModelo.textContent, /erro ao carregar/);
});

test('biblioteca de detecção ausente (sem internet): aviso visível e mensagem clara, sem exceção crua', async () => {
  const a = await montar({semCocoSsd: true}); assert.equal(a.els.avisoRede.hidden, false);
  await a.iniciar(); assert.equal(a.estado(), 'modelo_indisponivel'); assert.match(a.els.status.textContent, /biblioteca de detecção não foi carregada/);
  assert.doesNotMatch(a.els.status.textContent, /cocoSsd|is not defined/); assert.equal(a.cont.paradas, a.cont.trilhas);
});

test('sem síntese de voz: não inicia (não pede a câmera) e explica; "Testar áudio" também explica, sem fingir que falou', async () => {
  const a = await montar({semVoz: true}); assert.match(a.els.mVoz.textContent, /indisponível/);
  await a.iniciar(); assert.equal(a.cont.gum, 0); assert.match(a.els.status.textContent, /síntese de voz/); assert.equal(a.estado(), 'ocioso');
  a.els.btnTeste.onclick(); assert.match(a.els.status.textContent, /Síntese de voz indisponível/); assert.deepEqual(a.falas, []);
});

test('câmera perdida durante a análise: para tudo, libera a câmera, avisa "Pare e aguarde" uma vez e não reaproveita nada', async () => {
  const a = await montar({script: [[cadD]], vals: {intervalo: 20}}); await a.iniciar(); await ate(() => a.calls() > 5);
  a.fimCamera();
  assert.equal(a.estado(), 'camera_indisponivel'); assert.equal(a.cont.paradas, 1);
  assert.equal(a.els.oDec.textContent, 'analise_insuficiente'); assert.match(a.els.oReg.textContent, /E: desconhecida · F: desconhecida · D: desconhecida/);
  assert.match(a.els.status.textContent, /Falha: A câmera foi desconectada/);
  const c = a.calls(); await sleep(250); assert.equal(a.calls(), c, 'inferência continuou com a câmera perdida');
  assert.equal(a.falas.filter(t => t === 'Atenção: a análise da câmera foi interrompida. Pare e aguarde.').length, 1);
  a.fimCamera(); assert.equal(a.falas.filter(t => /Pare e aguarde/.test(t)).length, 1, 'aviso repetido');
  assert.equal(a.els.btnIniciar.disabled, false); assert.equal(a.els.btnPausar.disabled, true);
});

test('câmera perdida com a assistência pausada: retomar não volta a analisar com a câmera morta', async () => {
  const a = await montar({}); await a.iniciar(); a.pausar(); assert.equal(a.estado(), 'pausado');
  a.fimCamera(); assert.equal(a.estado(), 'camera_indisponivel');
  a.pausar(); await sleep(100); assert.equal(a.estado(), 'camera_indisponivel'); assert.equal(a.cont.paradas, 1);
});

test('botões e seletores refletem o estado real (Pausar/Retomar; modelo e câmera travados durante a sessão)', async () => {
  const a = await montar({}); const e = a.els;
  assert.equal(e.btnIniciar.disabled, false); assert.equal(e.btnPausar.disabled, true); assert.equal(e.modelo.disabled, false); assert.match(e.estado.textContent, /Pronta/);
  await a.iniciar();
  assert.equal(e.btnIniciar.disabled, true); assert.equal(e.btnPausar.textContent, 'Pausar'); assert.equal(e.modelo.disabled, true); assert.equal(e.camSel.disabled, true);
  assert.equal(e.estado.textContent, 'Assistência ativa'); assert.equal(e.estado.dataset.estado, 'ativo');
  a.pausar(); assert.equal(e.btnPausar.textContent, 'Retomar'); assert.equal(e.estado.textContent, 'Assistência pausada');
  a.pausar(); assert.equal(e.btnPausar.textContent, 'Pausar'); assert.equal(a.estado(), 'ativo');
  a.encerrar(); assert.equal(e.modelo.disabled, false); assert.equal(e.btnEncerrar.disabled, true); assert.equal(e.estado.textContent, 'Pronta para iniciar');
});

test('selo de estado mostra "análise inconclusiva" quando os dados não permitem conclusão (texto, não só cor)', async () => {
  const a = await montar({script: [null], vals: {intervalo: 20}}); await a.iniciar(); await ate(() => a.calls() > 3);
  try { assert.equal(a.els.estado.textContent, 'Assistência ativa · análise inconclusiva'); assert.equal(a.els.estado.dataset.estado, 'inconclusiva'); }
  finally { a.encerrar(); }
});

test('teclado: Espaço inicia/pausa no corpo da página; ignorado em campos, em botões e quando repetido; Esc cancela o início', async () => {
  const a = await montar({});
  for (const tag of ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']) a.disparar('keydown', {code: 'Space', target: {tagName: tag}});
  a.disparar('keydown', {code: 'Space', repeat: true, target: {tagName: 'BODY'}}); a.disparar('keydown', {code: 'Space', ctrlKey: true, target: {tagName: 'BODY'}});
  assert.equal(a.cont.gum, 0, 'atalho disparou dentro de um controle');
  const ev = a.disparar('keydown', {code: 'Space', target: {tagName: 'BODY'}}); assert.equal(ev.prevenido, true);
  assert.equal(a.estado(), 'solicitando_camera');
  a.disparar('keydown', {code: 'Escape', target: {tagName: 'BODY'}}); assert.equal(a.estado(), 'ocioso');
  await sleep(50); assert.equal(a.cont.paradas, a.cont.trilhas);
  a.disparar('keydown', {code: 'Space', target: {tagName: 'BODY'}}); await ate(() => a.estado() === 'ativo');
  a.disparar('keydown', {code: 'Space', target: {tagName: 'BODY'}}); assert.equal(a.estado(), 'pausado');
  a.disparar('keydown', {code: 'Escape', target: {tagName: 'BUTTON'}}); assert.equal(a.estado(), 'ocioso');
});

test('página em segundo plano pausa a análise e a retomada é explícita', async () => {
  const a = await montar({}); await a.iniciar();
  a.document.hidden = true; a.disparar('visibilitychange'); assert.equal(a.estado(), 'pausado'); assert.match(a.els.status.textContent, /segundo plano/);
  a.document.hidden = false; a.disparar('visibilitychange'); assert.equal(a.estado(), 'pausado');
  a.encerrar();
});

test('[simulado] predição malformada (NaN, caixa vazia, fora do quadro): nada de obstáculo nem direção; "não foi possível avaliar"', async () => {
  const ruins = [[d('chair', [NaN, 150, 80, 150])], [d('chair', [540, 150, 80, 150], NaN)], [d('person', [100, 100, 0, 0])], [d('chair', [5000, 150, 80, 150]), cadD]];
  for (const pr of ruins){
    const a = await montar({script: [pr], vals: {intervalo: 20}}); await a.iniciar(); await ate(() => a.calls() > 6);
    try {
      const f = a.falas.filter(t => !/^Assistência/.test(t));
      assert.deepEqual(f, ['Não foi possível avaliar a passagem adequadamente.'], JSON.stringify(pr));
      assert.equal(a.els.oDec.textContent, 'analise_insuficiente'); assert.match(a.els.oMot.textContent, /malformad/);
    } finally { a.encerrar(); }
  }
});

test('trocar de modelo entre sessões libera o anterior (dispose) e carrega o novo uma única vez', async () => {
  const a = await montar({}); await a.iniciar(); a.encerrar();
  a.els.modelo.value = 'mobilenet_v2'; await a.iniciar(); a.encerrar();
  assert.equal(a.cont.cargas, 2); assert.equal(a.cont.dispose, 1); assert.match(a.els.mModelo.textContent, /mobilenet_v2/);
  await a.iniciar(); a.encerrar(); assert.equal(a.cont.cargas, 2, 'mesmo modelo recarregado');
});

test('10 ciclos de iniciar/encerrar rápidos: nenhuma câmera esquecida, nenhuma cadeia de inferência duplicada', async () => {
  const a = await montar({detectMs: 10, vals: {intervalo: 40}});
  for (let k = 0; k < 10; k++){ const p = a.iniciar(); if (k % 2) await p; a.encerrar(); await p; }
  assert.equal(a.cont.paradas, a.cont.trilhas, 'câmeras abertas: ' + (a.cont.trilhas - a.cont.paradas));
  const c0 = a.calls(); await sleep(200); assert.equal(a.calls(), c0, 'inferência rodando após encerrar');
  await a.iniciar(); await sleep(600); const n = a.calls(); a.encerrar();
  assert.equal(a.maxEm(), 1); assert.ok(n <= 600 / 40 + 2, 'cadeia duplicada: ' + n + ' inferências em 600 ms');
});

test('encerrar cala a fala em andamento e nada é falado depois por resultados atrasados', async () => {
  const a = await montar({script: [[cadD]], detectMs: 60, vals: {intervalo: 20}}); await a.iniciar(); await sleep(30);
  const c0 = a.cancels(); a.encerrar(); assert.ok(a.cancels() > c0);
  const n = a.falas.length; await sleep(250); assert.equal(a.falas.length, n);
});

test('sem aceleração gráfica (backend "cpu"): a sessão inicia e o usuário é avisado de que a análise fica lenta', async () => {
  const a = await montar({tfBackend: 'cpu'}); await a.iniciar();
  try {
    assert.equal(a.estado(), 'ativo'); assert.match(a.els.status.textContent, /sem aceleração gráfica/); assert.match(a.els.mBackend.textContent, /^cpu \(sem aceleração/);
  } finally { a.encerrar(); }
  const b = await montar({tfBackend: 'webgl'}); await b.iniciar();
  try { assert.equal(b.els.status.textContent, 'Assistência ativa.'); assert.equal(b.els.mBackend.textContent, 'webgl'); } finally { b.encerrar(); }
});

test('painel: com a sessão ativa o estado da análise nunca aparece como "pronto" (parecia parado entre duas análises)', async () => {
  const a = await montar({detectMs: 5, vals: {intervalo: 200}}); await a.iniciar();
  try {
    for (let k = 0; k < 6; k++){ await sleep(90); assert.notEqual(a.els.mEst.textContent, 'pronto'); }
    assert.match(a.els.mEst.textContent, /^(analisando|em execução \(entre análises\))$/);
  } finally { a.encerrar(); }
  assert.equal(a.els.mEst.textContent, 'pronto', 'depois de encerrar, com o modelo carregado, o estado é "pronto"');
});

test('aviso de arquivos ausentes: o app o esconde quando carrega; no HTML ele existe e o CSS o oculta', async () => {
  const a = await montar({}); assert.equal(a.els.avisoArquivos.hidden, true);
  const fs = require('fs'), path = require('path'), raiz = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(raiz, 'visioindustria.html'), 'utf8'), /id="avisoArquivos"[^>]*>[\s\S]*css\/[\s\S]*js\//);
  assert.match(fs.readFileSync(path.join(raiz, 'css', 'visioindustria.css'), 'utf8'), /#avisoArquivos\{display:none\}/);
});
