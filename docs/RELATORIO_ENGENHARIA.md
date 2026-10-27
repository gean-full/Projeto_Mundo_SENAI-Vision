# Relatório final: Pew_Pew Vision Indústria (VisioIndústria)

Data: 27/10/2026 · Branch local `melhorias-ciclo-de-vida` sobre `main` (`000dced`) de `gean-full/vs_indus_22-10`

Estado do repositório público conferido em 27/10/2026, 21h: `gean-full/vs_indus_22-10` continua na versão anterior. Pelas capturas enviadas, a publicação nova foi feita num repositório separado sem as pastas `css/`, `js/` e `icones/`. Este trabalho não tem acesso de escrita ao GitHub (a conta não está conectada), então as mudanças são entregues como zip, patch e bundle git.

## 1. Resumo da implementação

**Finalidade verificada no código e na documentação:** app web de apoio à percepção de obstáculos. A câmera do celular alimenta o COCO-SSD (TensorFlow.js, no navegador), o app indica a posição dos objetos na imagem (esquerda, frente, direita) e fala avisos em português. É uma ferramenta complementar: não mede distância, não garante caminho livre e não controla máquinas.

**Já existia e foi preservado:** agendador de inferência sem sobreposição, contrato temporal das fontes de dados, decisão de orientação conservadora, heurística de piso experimental, modo pista experimental, painel de métricas e exportação em CSV.

**Corrigido ou adicionado:**

| Problema | Correção |
|---|---|
| Apertar Espaço durante o início abria uma segunda câmera, e a primeira vazava | Ciclo de vida explícito (`criarCicloDeVida`) com número de sessão |
| Não dava para cancelar durante o pedido de permissão ou a carga do modelo | "Cancelar"/Esc funcionam; câmera e carga que chegam atrasadas não reativam a sessão |
| Um `score` NaN virava detecção confiante, sempre "à direita" | `validarPredicoes`: o resultado com predição malformada vira "análise insuficiente" |
| Câmera desconectada deixava a sessão "ativa" e gerava erros em sequência | Para tudo, libera a câmera, mostra "câmera indisponível" e fala "Pare e aguarde" uma vez |
| Ao trocar de câmera, a escolha voltava para "Padrão"; o modelo anterior continuava ocupando memória | Seleção mantida; `dispose()` do modelo anterior |
| Erros de câmera em inglês cru; `cocoSsd is not defined` sem internet | Mensagens em português por tipo de falha; aviso de biblioteca ausente |
| Sem voz, o status era sobrescrito; falhas de fala eram ignoradas | Estado da voz e falhas de fala no painel; "Testar áudio" explica a ausência de voz |
| Atalho Espaço com foco num botão disparava duas ações | Atalhos ignorados em botões, campos, tecla repetida e com modificadores |
| Botão "Pausar" não virava "Retomar"; seletores de modelo e câmera ativos durante a sessão, sem efeito | Controles derivados do ciclo de vida |
| Painel mostrava "pronto" com a análise rodando (entre dois ciclos) | Mostra "em execução (entre análises)" |
| Sem WebGL, o app ficava lento sem explicação | Aviso "sem aceleração gráfica" no status e no painel |
| Publicação sem as pastas `css/` e `js/` abria uma página quebrada e muda (caso real) | Aviso estático visível que nomeia as pastas que faltam |
| `node --test` falhava (caminho errado do HTML) | Testes em `testes/`, `npm test` |
| Scripts do CDN sem verificação de integridade | SRI sha384 + CSP |

## 2. Alterações realizadas

**Criados:** `js/nucleo.js` (lógica pura), `js/app.js` (interface, câmera, modelo e voz), `js/pwa.js`, `sw.js`, `manifest.webmanifest`, `css/visioindustria.css`, `icones/` (SVG, 192 e 512 px), `package.json`, `.github/workflows/testes.yml`, `README.md`, `docs/RELATORIO_ENGENHARIA.md`, `testes/apoio.js`, `testes/nucleo.test.js`, `testes/ciclo-de-vida.test.js`, `testes/pwa-e-publicacao.test.js` e `testes/navegador/verificar.js`.

**Modificados:** `visioindustria.html` (sem JS nem CSS embutidos, CSP, SRI, selo de estado, painéis recolhíveis, avisos), `MEDICAO_E_PWA.md` (seção 3 atualizada com o estado real do PWA e os tamanhos medidos dos modelos).

**Movidos:** `visioindustria.test.js` para `testes/`; `ALTERACOES_*.diff` para `docs/historico/`, porque são patches de etapas anteriores e não fazem parte da execução.

**Decisões de arquitetura:**

- Continua estático, sem framework, build nem backend, e publicável no GitHub Pages.
- O núcleo é um script clássico, que funciona no navegador (`window.VisioNucleo`) e no Node (`require`). Os testes deixaram de recortar o HTML por marcadores de texto.
- O estado da sessão tem uma fonte única (o ciclo de vida); botões, selo e agendador derivam dela.
- A saída do modelo é tratada como dado não confiável, e as predições brutas ficam separadas da decisão.
- A CSP precisa de `'unsafe-eval'` porque o TensorFlow.js 4.22 usa `Function()`: sem isso a carga do modelo falhou no Chromium. Scripts embutidos continuam proibidos.
- O PWA guarda só a casca do app; a detecção não funciona offline e a interface diz isso.
- **Não implementado de propósito:** persistência dos ajustes, porque nenhum requisito pede e o app hoje não guarda nada no aparelho; hospedagem local das bibliotecas e dos pesos, porque o envio manual ao GitHub ficaria mais pesado.

## 3. Testes e verificações

| Comando | Resultado real |
|---|---|
| Antes: `node --test visioindustria.test.js` | Falha (caminho do HTML) |
| Antes: `VISIO_HTML=$PWD/visioindustria.html node --test visioindustria.test.js` | 96/96 |
| `npm run check` | OK |
| `npm test` (Node 22.22.0) | **138/138** (96 originais + 42 novos), cerca de 90 s |
| `ATIVOS=… node testes/navegador/verificar.js` (Chromium sem interface, Playwright) | **19/19 OK** |
| Página publicada só com os arquivos da raiz (reprodução do caso real, Chromium) | Aviso "O aplicativo não carregou por completo" visível |

**Falhas encontradas e corrigidas durante a verificação:**

- A CSP bloqueava o TensorFlow.js.
- O service worker não instalava em servidores sem página de índice para pastas.
- A tela tinha rolagem horizontal em 320 px.
- Um teste dependia da origem do relógio do processo.

**Como cada verificação foi feita:**

- **Testes com dependências simuladas:** os testes "app" e de ciclo de vida usam câmera, modelo e voz simulados. Validam a lógica, não a precisão.
- **No navegador:** câmera falsa do Chromium alimentada com uma foto real, TensorFlow.js e COCO-SSD reais e pesos reais do modelo Leve. Os scripts e os pesos foram servidos de cópias locais, porque o jsDelivr está bloqueado na rede deste ambiente. O modelo detectou pessoas e o app falou "Pessoa à frente e pessoa à esquerda. Não foi possível avaliar a passagem adequadamente." Também passaram: pausa, retomada, encerramento com câmera liberada, atalhos, service worker, abertura sem rede com aviso, nenhuma violação de CSP e nenhum erro no console.
- **Não executado:** nenhum teste em celular, câmera física, voz real (o Chromium sem interface não tem vozes) ou cena industrial. A igualdade do hash SRI com o arquivo que o jsDelivr serve não foi conferida diretamente; o hash foi calculado sobre os arquivos do npm, que é a fonte do jsDelivr.

## 4. Estado da aplicação

**Funcionalidades verificadas (navegador ou testes):**

- início, pausa, retomada, encerramento e cancelamento;
- detecção real com COCO-SSD;
- avisos falados (texto gerado; a voz não foi ouvida);
- caixas e barras sobre a imagem;
- tratamento de permissão negada, câmera ausente, câmera perdida, modelo que não carrega, ausência de internet e de voz, e predições inválidas;
- painel de métricas e CSV;
- PWA instalável.

**Dependências:**

- navegador com câmera e `speechSynthesis`;
- https ou localhost;
- internet para o TensorFlow.js 4.22.0 e o COCO-SSD 2.2.3 (jsDelivr) e para os pesos (Google Storage);
- os pesos medem 18,6 MB no modelo Leve e 67,8 MB no Preciso.

**Limitações conhecidas:**

- O COCO-SSD não reconhece parede, porta, palete, carrinho, degrau ou buraco.
- Não há distância, segmentação, profundidade nem rastreamento.
- A heurística de piso e o modo pista são experimentais.
- Os limiares não estão calibrados.
- A detecção não funciona offline.
- Neste ambiente, sem GPU, a inferência levou cerca de 1,1 s por quadro. Isso não representa um celular.

**Requisitos ainda não atendidos:**

- medição em aparelhos reais (latência, FPS, bateria, aquecimento);
- validação em campo da heurística de piso;
- comportamento em chamadas e com a tela bloqueada no celular.

## 5. Como executar

- **Instalação:** nenhuma dependência. Para os testes, Node 21 ou mais novo.
- **Local:** `npm run serve` (ou `python3 -m http.server 8080`) e abrir `http://localhost:8080/visioindustria.html`.
- **Testes:** `npm test` e `npm run check`. A verificação opcional no navegador está descrita no topo de `testes/navegador/verificar.js`.
- **Publicação no GitHub Pages (envio pela web):**
  1. Em **Add file → Upload files**, arraste o conteúdo da pasta **com as subpastas**. Elas precisam ser arrastadas, porque o botão de escolher arquivos não aceita pastas.
  2. Confira se aparecem `js/app.js` e `css/visioindustria.css`.
  3. Em **Settings → Pages**, escolha `main` e `/ (root)`. O repositório precisa ser público no plano gratuito.
  4. A cada nova versão, troque `VERSAO` em `sw.js`.

## 6. Próximas prioridades

1. **Publicar com as pastas** e abrir no celular: conferir que não aparece o aviso de biblioteca ausente (isso confirma o SRI do jsDelivr), testar a voz em pt-BR e o comportamento ao bloquear a tela.
2. **Medir em 2 ou 3 celulares** com o procedimento de `MEDICAO_E_PWA.md`. Isso bloqueia a calibração dos limiares e a escolha do modelo padrão: hoje é o Preciso, de 68 MB, e o Leve tem 19 MB.
3. **Calibrar `LIM`** com os dados medidos.
4. **Conectar o GitHub** a esta sessão para que as próximas mudanças cheguem por PR, sem envio manual.
5. Se for necessário funcionar offline: hospedar as bibliotecas e os pesos do modelo Leve no próprio repositório e incluí-los no service worker.
6. Para as classes que o COCO-SSD não cobre: um detector treinado com imagens da própria fábrica.

**Riscos remanescentes:**

- Usuários podem tomar a ausência de aviso como caminho livre. A interface e as falas dizem o contrário, mas isso depende de treinamento.
- Dependência do CDN e do Google Storage.
- `'unsafe-eval'` na CSP.
