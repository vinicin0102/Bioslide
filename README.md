# BIO SLIDES — 150 Slides de Biologia Prontos

Landing page de vendas com checkout PIX integrado à **ZuckPay**.

```
index.html               página de vendas + modal de checkout
api/pix.php              cria a cobrança PIX
api/status.php           consulta o status do pagamento
api/webhook.php          recebe a notificação da ZuckPay
api/diagnostico.php      checagem da integração (protegido por token)
assets/                  vídeo da primeira dobra, slides e fotos dos carrosséis
tools/testar-webhook.php testa a validação de assinatura do webhook (CLI)
api/_bootstrap.php       validação, CORS e chamada autenticada à API
api/config.example.php   modelo de configuração
storage/                 log de pagamentos (não versionado)
```

## Configuração

```bash
cp api/config.example.php api/config.php
```

Preencha `client_id`, `client_secret`, `webhook_url`, `webhook_secret` e
`allowed_origins`. O **Webhook Secret** é gerado no painel em
*Integrações > Webhook Secret* e é diferente do Client Secret; sem ele os
postbacks chegam sem assinatura e só resta a verificação por reconsulta.

O `api_base` precisa usar **exatamente o host da sua tela de Credenciais API**
(com ou sem `www`). Com o host errado a ZuckPay responde um redirecionamento,
e um POST autenticado não é reenviado no redirect — a cobrança nunca chega.
Este é o motivo mais comum de "o PIX não gera".
`api/config.php` está no `.gitignore` — **nunca** versione esse arquivo.
Em produção prefira variáveis de ambiente (`ZUCKPAY_CLIENT_ID` /
`ZUCKPAY_CLIENT_SECRET`), que o `config.example.php` já lê.

Requisitos: PHP 8+ com a extensão cURL. O front chama `/api`; se a pasta não
ficar na raiz do site, ajuste a constante `API` no script de checkout do
`index.html`.

## Como funciona

1. O professor clica em um dos planos, preenche nome, CPF, e-mail e telefone
   e marca os order bumps que quiser.
2. `api/pix.php` valida os dados, soma plano + bumps com os preços do
   `config.php` e chama `POST /conta/v3/pix/qrcode`.
3. A página mostra o QR Code e o copia-e-cola, e consulta `api/status.php`
   a cada 4s até o pagamento ser confirmado.
4. A ZuckPay chama `api/webhook.php`, que confirma o pagamento e registra a venda.

Planos (em `config.php`):

| id | Produto | Valor |
|---|---|---|
| `slides` | 🧬 BIO SLIDES — 150 slides prontos, +50 matérias | R$ 12,90 |
| `biobox` | 💎 BIOBOX PROFESSOR — biblioteca completa | R$ 27,00 |

Order bumps (em `config.php`, chave `bumps`):

| id | Código | Bump | Valor | Oferecido no BIOBOX? |
|---|---|---|---|---|
| `jogos` | j | 🎲 50 Jogos de Biologia | R$ 4,90 | não (já incluso) |
| `provas` | p | 📝 50 Provas + Gabaritos | R$ 7,90 | não (já incluso) |
| `praticas` | x | 🔬 30 Aulas Práticas | R$ 7,90 | não (já incluso) |
| `atividades` | a | 📋 100 Atividades de Fixação | R$ 4,90 | não (já incluso) |
| `genetica` | g | 🧬 Kit Genética | R$ 4,90 | sim |
| `ecologia` | e | 🌱 Kit Ecologia | R$ 4,90 | sim |
| `prompts` | i | 🤖 100 Prompts para Professores | R$ 7,90 | sim |

O navegador envia só os ids; o servidor ignora ids desconhecidos e bumps já
inclusos no plano. Plano e bumps vão no `external_id_client` da cobrança
(`BS-<plano>-<códigos>-<pedido>`, ex.: `BS-slides-jg-…`), e o webhook os
decodifica (`itensDoPedido()`) e grava no log para a entrega saber o que foi pago.
No checkout do BIO SLIDES aparece também o upgrade para o BIOBOX (+ R$ 14,10).

Preencha o `product_id` de cada plano com o id do produto cadastrado no painel
da ZuckPay (com `0` ele não é enviado).

## Vídeo da primeira dobra

O topo da página mostra um vídeo. Envie o arquivo para `assets/video-hero.mp4`
(capa opcional em `assets/video-hero.jpg`) ou troque a constante `VIDEO_HERO`
no `index.html` por um link do YouTube ou Vimeo. O vídeo fica parado na capa com
um botão de play e só toca, já com som, quando o visitante clica.
Sem vídeo, a página mostra o mockup animado das aulas no lugar.

## Conferir o webhook

Depois de configurar o `webhook_secret`, rode **no servidor**:

```bash
php tools/testar-webhook.php
```

Ele monta POSTs assinados como a ZuckPay faz e confere que o endpoint aceita
o legítimo e recusa assinatura falsa, replay e requisição sem header:

```
[ok]   assinatura válida        (esperado: 200) -> HTTP 200
[ok]   assinatura falsa         (esperado: 401) -> HTTP 401
[ok]   replay de 10 minutos     (esperado: 401) -> HTTP 401
[ok]   sem header de assinatura (esperado: 401) -> HTTP 401
```

O segredo é lido do `config.php`; nunca passe por argumento, porque a linha de
comando fica visível para outros processos e no histórico do shell.

## Se o PIX não gerar

1. Defina um `debug_token` no `config.php` e abra:
   `https://seu-dominio.com.br/api/diagnostico.php?token=SEU_TOKEN`

   Ele confere PHP, cURL, credenciais (mascaradas), planos e faz uma cobrança
   de teste de R$ 1,00, mostrando a resposta real da ZuckPay. Os diagnósticos
   possíveis:

   | Resultado | Causa provável |
   |---|---|
   | `REDIRECIONAMENTO` | `api_base` com o host errado (`www` sobrando ou faltando). O diagnóstico mostra o endereço certo em `va_para` e testa a variante em `alternativa`. |
   | `IP BLOQUEADO` | Credenciais válidas, mas o IP do servidor não está na IP Whitelist da ZuckPay. O diagnóstico mostra o IP a liberar. |
   | `RATE LIMIT` | 5 tentativas por 30 minutos. Aguarde. |
   | `FALHA DE CONEXAO` | A hospedagem bloqueia conexões de saída, ou DNS. |
   | `NAO AUTORIZADO` | `client_id`/`client_secret` errados, revogados ou sem permissão para PIX. |
   | `ENDPOINT NAO ENCONTRADO` | `api_base` incorreto. |
   | `OK` | A integração funciona — o problema está no front ou no caminho `/api`. |

2. Se der `OK` no diagnóstico mas o botão da página continuar falhando, o
   problema é o caminho: abra o console do navegador (F12) e veja se o
   `POST /api/pix.php` retorna 404. Nesse caso a pasta `api/` não está onde o
   front espera — ajuste a constante `API` no script de checkout do `index.html`.

3. Ligue `'debug' => true` no `config.php` para que a página mostre o motivo
   real da falha em vez da mensagem genérica. **Desligue depois**, junto com o
   `debug_token`.

## Decisões de segurança

Estas escolhas são deliberadas — mudá-las abre brecha real:

- **O `client_secret` nunca vai para o navegador.** A documentação da ZuckPay
  mostra um exemplo em JavaScript com `btoa(clientId + ':' + clientSecret)`
  rodando no front. Seguir aquele exemplo publica a credencial no código-fonte
  da página: qualquer visitante poderia criar cobranças, listar transações e
  consultar o saldo da conta. Por isso a chamada é feita em PHP, no servidor.
- **O preço é definido no servidor.** `api/pix.php` recebe só o *id* do plano
  (`basico` / `premium`) e busca o valor na constante `PLANOS`. Um `valor`
  enviado pelo navegador é ignorado — sem isso, bastaria editar a requisição
  para comprar o Premium por R$ 0,01.
- **As respostas são filtradas.** A API devolve `amount_liquid`, e-mail do
  comprador e outros campos internos; os endpoints repassam apenas o necessário.
- **O webhook é verificado em duas camadas.** Primeiro a assinatura HMAC do
  header `X-ZuckPay-Signature` (`HMAC-SHA256("<timestamp>.<corpo_raw>",
  webhook_secret)`), com janela anti-replay de 5 minutos — prova que o POST
  veio da ZuckPay. Depois o `transactionId` é reconsultado na API — prova que
  o pagamento está pago agora. O corpo do POST nunca é a fonte da verdade, então
  um `"status":"PAID"` forjado não libera nada.
- **Entradas são validadas**: CPF com dígito verificador, e-mail, telefone e
  limite de tamanho. Parâmetros de atribuição passam por whitelist.
- **A entrega roda uma vez só.** A ZuckPay reenvia notificações. Antes de
  entregar, `webhook.php` cria um arquivo-marcador com `fopen(..., 'x')`, que
  falha se já existir — duas notificações simultâneas não passam as duas.
- **Cobranças não duplicam.** Cada abertura do checkout gera um `pedido`, usado
  como `external_id_client`. Clicar duas vezes devolve a mesma cobrança em vez
  de criar outra.

## Rate limit

A ZuckPay responde **429 após 5 tentativas em 30 minutos**. Por isso:

- `status.php` guarda a última consulta por 8 segundos, então várias abas ou
  recarregamentos não geram chamadas repetidas.
- Quando a API devolve 429, a resposta pede à página para esperar 30s em vez
  dos 5s normais; o front respeita esse intervalo.
- `webhook.php` responde na hora a `payment_refused`, `payment_pending` e
  `checkout_abandoned`, sem gastar uma chamada de verificação.

## Pendências

1. **Entrega do produto** — `api/webhook.php` tem um `TODO` no ponto onde entra
   o envio do e-mail com os PDFs ou a liberação da área de membros. A ZuckPay
   pode reenviar a mesma notificação, então grave o `transactionId` e só
   entregue uma vez.
2. **Imagens dos carrosséis** — `assets/slides/*.jpg` (9 slides) e
   `assets/professores/*.jpg` (fotos dos depoimentos) foram recortadas de
   capturas de tela. Troque pelos arquivos originais, com o mesmo nome, para
   ganhar nitidez. Os textos ficam nas listas `SLIDES` e `DEPOIMENTOS` do
   `index.html`.
3. **Depoimentos e avaliação** — mantenha só depoimentos reais, com
   autorização de quem aparece, e atualize a nota/quantidade de avaliações
   (`5,0 · 774 avaliações verificadas`) conforme os números reais.
4. **Rate limiting** — não há limite de requisições em `api/pix.php`. Vale pôr
   um limite por IP para evitar geração de cobranças em massa.
5. **Desativar o diagnóstico** — depois de resolver, apague `api/diagnostico.php`
   ou deixe `debug_token` vazio (assim ele responde 404).
