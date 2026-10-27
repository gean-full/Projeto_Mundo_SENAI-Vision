'use strict';
// Testes da lógica PURA nova do núcleo: validação das predições, ciclo de vida e mensagens de erro. Sem relógio real, sem esperas.
const test = require('node:test'), assert = require('node:assert/strict');
const { criarNucleoVisio } = require('./apoio.js');
const P = criarNucleoVisio();

const W = 640, H = 480, pr = (cls, score, bbox) => ({class: cls, score, bbox});

test('validarPredicoes: aceita predições bem formadas e recorta caixas um pouco além da borda', () => {
  const r = P.validarPredicoes([pr('chair', .8, [10, 20, 100, 200]), pr('person', 1, [-20, -10, 120, 100]), pr('car', 0, [600, 400, 60, 90])], W, H);
  assert.equal(r.descartadas, 0); assert.equal(r.motivo, '');
  assert.deepEqual(r.validas.map(p => p.bbox), [[10, 20, 100, 200], [0, 0, 100, 90], [600, 400, 40, 80]]);
});

test('validarPredicoes: NaN, Infinity, confiança fora de 0..1, caixa vazia, formato errado e caixa fora do quadro são descartados', () => {
  const ruins = [
    pr('chair', NaN, [10, 10, 50, 50]), pr('chair', 1.2, [10, 10, 50, 50]), pr('chair', -.1, [10, 10, 50, 50]), pr('chair', '0.9', [10, 10, 50, 50]),
    pr('chair', .9, [NaN, 10, 50, 50]), pr('chair', .9, [10, 10, Infinity, 50]), pr('chair', .9, [10, 10, 0, 50]), pr('chair', .9, [10, 10, 50, -5]),
    pr('chair', .9, [10, 10, 50]), pr('chair', .9, null), pr(42, .9, [10, 10, 50, 50]), null, 'lixo',
    pr('chair', .9, [W + 100, 10, 50, 50]), pr('chair', .9, [-200, 10, 50, 50]), pr('chair', .9, [10, 10, W * 2, 50])
  ];
  const r = P.validarPredicoes(ruins, W, H);
  assert.equal(r.validas.length, 0); assert.equal(r.descartadas, ruins.length); assert.match(r.motivo, /malformadas descartadas/);
});

test('validarPredicoes: entrada que não é lista ou quadro sem dimensões não produz nenhuma predição válida', () => {
  for (const x of [null, undefined, {}, 'x', 3]) assert.equal(P.validarPredicoes(x, W, H).validas.length, 0);
  assert.match(P.validarPredicoes(null, W, H).motivo, /inválido/);
  for (const [w, h] of [[0, H], [W, 0], [NaN, H], [W, undefined]]){
    const r = P.validarPredicoes([pr('chair', .9, [1, 1, 5, 5])], w, h); assert.equal(r.validas.length, 0); assert.equal(r.descartadas, 1);
  }
});

test('segurança: sem a validação, NaN viraria detecção confiante na "direita"; com ela, nada entra na decisão', () => {
  // Demonstra o defeito corrigido: comparação com NaN é sempre falsa, então NaN "passa" pelo limiar, e o bbox NaN cai na zona direita.
  assert.equal(NaN < P.limiar(P.CLASSES.chair, .6), false);
  assert.equal(P.zonaDe([NaN, 0, NaN, 10], W), 'direita');
  assert.equal(P.validarPredicoes([pr('chair', NaN, [NaN, 0, NaN, 10])], W, H).validas.length, 0);
});

test('ciclo de vida: caminho normal, pausa, retomada e encerramento', () => {
  const mud = []; const v = P.criarCicloDeVida((para, de) => mud.push(de + '→' + para));
  assert.equal(v.estado(), 'ocioso'); assert.equal(v.emSessao(), false); assert.equal(v.iniciando(), false);
  const s = v.abrir(); assert.ok(s > 0); assert.equal(v.estado(), 'solicitando_camera'); assert.equal(v.iniciando(), true);
  assert.equal(v.transitar('carregando_modelo', s), true); assert.equal(v.transitar('ativo', s), true); assert.equal(v.emSessao(), true);
  assert.equal(v.transitar('pausado'), true); assert.equal(v.transitar('ativo'), true);
  v.encerrar(); assert.equal(v.estado(), 'ocioso'); assert.equal(v.vale(s), false);
  assert.deepEqual(mud, ['ocioso→solicitando_camera', 'solicitando_camera→carregando_modelo', 'carregando_modelo→ativo', 'ativo→pausado', 'pausado→ativo', 'ativo→ocioso']);
});

test('ciclo de vida: não abre uma segunda sessão enquanto inicia ou roda; sessão encerrada não muda mais o estado', () => {
  const v = P.criarCicloDeVida(), s = v.abrir();
  assert.equal(v.abrir(), 0, 'segunda abertura durante o início');
  v.transitar('carregando_modelo', s); assert.equal(v.abrir(), 0);
  v.encerrar();                                                    // usuário cancelou durante a carga do modelo
  assert.equal(v.transitar('ativo', s), false, 'carga atrasada ressuscitou a sessão encerrada'); assert.equal(v.estado(), 'ocioso');
  const s2 = v.abrir(); assert.ok(s2 > s); assert.equal(v.transitar('carregando_modelo', s), false, 'número de sessão antigo aceito');
  assert.equal(v.transitar('carregando_modelo', s2), true);
});

test('ciclo de vida: TODAS as transições fora da tabela são recusadas (varredura completa)', () => {
  const estados = Object.keys(P.TRANSICOES);
  // Caminho até cada estado, a partir de ocioso.
  const ir = {ocioso: [], solicitando_camera: [], carregando_modelo: ['carregando_modelo'], ativo: ['carregando_modelo', 'ativo'], pausado: ['carregando_modelo', 'ativo', 'pausado'],
    camera_indisponivel: ['camera_indisponivel'], modelo_indisponivel: ['carregando_modelo', 'modelo_indisponivel']};
  for (const de of estados) for (const para of estados){
    const v = P.criarCicloDeVida(); if (de !== 'ocioso') v.abrir(); for (const x of ir[de]) assert.ok(v.transitar(x), de + ' via ' + x);
    assert.equal(v.estado(), de);
    assert.equal(v.transitar(para), P.TRANSICOES[de].includes(para), de + ' → ' + para);
  }
});

test('ciclo de vida: falha no callback da interface não trava as transições', () => {
  const v = P.criarCicloDeVida(() => { throw new Error('interface quebrada'); });
  assert.ok(v.abrir()); assert.equal(v.estado(), 'solicitando_camera'); v.encerrar(); assert.equal(v.estado(), 'ocioso');
});

test('mensagemErroInicio: cada falha de câmera tem texto em português e acionável; nunca repassa a exceção crua', () => {
  const casos = {NotAllowedError: /Permissão da câmera negada/, NotFoundError: /Nenhuma câmera/, OverconstrainedError: /câmera escolhida não está disponível/,
    NotReadableError: /em uso por outro aplicativo/, SecurityError: /bloqueou/, AbortError: /interrompida/};
  for (const [name, re] of Object.entries(casos)){
    const t = P.mensagemErroInicio(Object.assign(new Error('Could not start video source'), {name}), 'camera');
    assert.match(t, re); assert.doesNotMatch(t, /Could not/);
  }
  assert.equal(P.mensagemErroInicio(new Error('x'), 'camera'), 'Não foi possível abrir a câmera.');
  assert.match(P.mensagemErroInicio(null, 'camera', {contextoSeguro: false}), /https ou em localhost/);
  assert.match(P.mensagemErroInicio(new Error('Failed to fetch'), 'modelo'), /carregar o modelo de detecção/);
  assert.equal(P.mensagemErroInicio({mensagemUsuario: 'Biblioteca ausente.'}, 'modelo'), 'Biblioteca ausente.');
});

test('estadoAnalise: o ciclo de vida tem precedência (aguardando câmera, câmera perdida); sem ele, o comportamento anterior se mantém', () => {
  assert.equal(P.estadoAnalise({modeloEstado: 'nao_carregado', running: false, vida: 'solicitando_camera'}), 'aguardando_camera');
  assert.equal(P.estadoAnalise({modeloEstado: 'pronto', running: false, vida: 'camera_indisponivel'}), 'camera_indisponivel');
  assert.equal(P.estadoAnalise({modeloEstado: 'pronto', running: true, paused: false, emCurso: true}), 'analisando');
});

test('segurança: câmera indisponível vira análise insuficiente, todas as regiões desconhecidas e nenhuma direção, nos dois modos', () => {
  for (const modo of ['padrao', 'pista']){
    const dec = P.decidirOrientacao({modo, agora: 1000, deteccao: {estado: 'camera_indisponivel', motivo: 'câmera perdida'}});
    assert.equal(dec.decisao, 'analise_insuficiente'); assert.equal(dec.permiteDirecao, false); assert.deepEqual(dec.passagens, []);
    assert.deepEqual(Object.values(dec.regioes), ['desconhecida', 'desconhecida', 'desconhecida']);
    const p = P.planejarSemObjetos(dec); assert.match(p.texto, modo === 'pista' ? /Pare e aguarde/ : /Não foi possível avaliar/);
  }
});

test('instâncias do núcleo são independentes: limites alterados numa não vazam para outra', () => {
  const a = criarNucleoVisio(), b = criarNucleoVisio();
  assert.equal(a.configurarLimites({compatMaxMs: 5}).aplicado, true);
  assert.equal(a.LIM.compatMaxMs, 5); assert.equal(b.LIM.compatMaxMs, 300);
});
