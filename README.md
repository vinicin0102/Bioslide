# BIO SLIDES — +250 Slides de Biologia Prontos

Landing page de vendas com checkout PIX integrado à **ZuckPay**.

```
index.html          página de vendas + modal de checkout
api/pix.js          cria a cobrança PIX (função do Vercel)
api/status.js       consulta o status do pagamento
api/webhook.js      recebe a notificação da ZuckPay
api/saude.js        checagem da integração (abra /api/saude)
api/_zuckpay.js     planos, bumps, validação e chamada autenticada à API
assets/             vídeo da primeira dobra, slides e fotos dos carrosséis
```

## Configuração (Vercel)

Em *Settings > Environment Variables* do projeto:

| Variável | Obrigatória | O que é |
|---|---|---|
| `ZUCKPAY_CLIENT_ID` (ou `cliend_id`) | sim | Client ID da tela de Credenciais API |
| `ZUCKPAY_CLIENT_SECRET` (ou `Client_Secret`) | sim | Client Secret da mesma tela |
| `ZUCKPAY_WEBHOOK_SECRET` | recomendada | *Integrações > Webhook Secret* (diferente do Client Secret) |
| `ZUCKPAY_API_BASE` | não | padrão `https://www.zuckpay.com.br/conta/v3/pix`; troque se a tela de Credenciais usar outro host (sem `www`) |
| `ZUCKPAY_PRODUCT_ID_SLIDES` / `ZUCKPAY_PRODUCT_ID_BIOBOX` | não | id do produto no painel da ZuckPay |
| `SITE_URL` | não | domínio próprio (ex.: `https://bioslide.com.br`); sem ela, usa o domínio de produção do Vercel |
| `ZUCKPAY_DEBUG` | não | `1` mostra no console do navegador o motivo real de uma falha. Desligue depois |

Depois de mudar variáveis, faça um **Redeploy** — elas só valem em deploys novos.

No painel da ZuckPay, cadastre o webhook `https://SEU-DOMINIO/api/webhook`.

Para conferir: abra `https://SEU-DOMINIO/api/saude`. Ele diz se as credenciais
foram encontradas e se a ZuckPay as aceita (sem mostrar valores e sem criar
cobrança).

## Como funciona

1. O professor clica em um dos planos, preenche nome, CPF, e-mail e telefone
   e marca os order bumps que quiser.
2. `api/pix.js` valida os dados, soma plano + bumps com os preços do servidor
   (`api/_zuckpay.js`) e chama `POST /conta/v3/pix/qrcode`.
3. A página mostra o QR Code e o copia-e-cola e consulta `api/status` até o
   pagamento ser confirmado.
4. A ZuckPay chama `api/webhook`, que confirma o pagamento na API e registra a
   venda nos logs do Vercel (linha `[venda]`).

Planos e bumps (preços em `api/_zuckpay.js`):

| id | Produto | Valor |
|---|---|---|
| `slides` | 🧬 BIO SLIDES — +250 slides prontos, +50 matérias | R$ 12,90 |
| `biobox` | 💎 BIOBOX PROFESSOR — biblioteca completa | R$ 27,00 |

Order bumps (em `api/_zuckpay.js`):

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

O navegador envia só os ids; o servidor ignora ids desconhecidos e bumps já
inclusos no plano. Plano e bumps vão no `external_id_client` da cobrança
(`BS-<plano>-<códigos>-<pedido>`), e o webhook os decodifica para a entrega
saber o que foi pago. No checkout do BIO SLIDES aparece o upgrade para o BIOBOX
(+ R$ 14,10).

## Vídeo da primeira dobra

O topo da página mostra um vídeo. Envie o arquivo para `assets/video-hero.mp4`
(capa opcional em `assets/video-hero.jpg`) ou troque a constante `VIDEO_HERO`
no `index.html` por um link do YouTube ou Vimeo. O vídeo fica parado na capa com
um botão de play e só toca, já com som, quando o visitante clica. Não há
barra de controles: tocar no vídeo pausa e o play volta a aparecer.
Sem vídeo, a página mostra o mockup animado das aulas no lugar.

## Se o PIX não gerar

Abra `/api/saude`:

| Diagnóstico | Causa provável |
|---|---|
| `Credenciais não encontradas` | variáveis com outro nome, ou falta o Redeploy depois de criá-las |
| `REDIRECIONAMENTO` | host errado: ajuste `ZUCKPAY_API_BASE` (com ou sem `www`) |
| `NÃO AUTORIZADO` | Client ID / Secret errados ou sem permissão para PIX |
| `BLOQUEADO` | a ZuckPay só aceita IPs liberados (IP whitelist). O Vercel não tem IP fixo: desative a whitelist na ZuckPay |
| `RATE LIMIT` | muitas tentativas; aguarde |
| `OK` | integração funcionando |

Para ver o motivo exato de uma falha, ponha `ZUCKPAY_DEBUG=1`, faça Redeploy e
veja o console do navegador (F12) ao gerar o PIX. Os erros também aparecem em
*Deployments > Logs* no Vercel.

## Decisões de segurança

- **O client_secret nunca vai para o navegador.** A chamada à ZuckPay roda na
  função do Vercel; a página só fala com `/api`.
- **O preço é definido no servidor.** Um `valor` enviado pelo navegador é ignorado.
- **As respostas são filtradas.** Valor líquido, dados do comprador e campos
  internos não voltam para a página.
- **O webhook é verificado em duas camadas:** assinatura HMAC do header
  `X-ZuckPay-Signature` (com `ZUCKPAY_WEBHOOK_SECRET`, janela anti-replay de 5
  min) e reconsulta do status na API. Um `"status":"PAID"` forjado não libera nada.
- **Entradas validadas:** CPF com dígito verificador, e-mail, telefone, tamanhos.
- **Cobranças não duplicam:** cada abertura do checkout gera um `pedido` usado
  no `external_id_client`.

## Pendências

1. **Entrega do produto** — `api/webhook.js` tem um `TODO` onde entra o envio
   do e-mail / liberação do acesso. Como as funções não guardam estado entre
   instâncias, grave o `transactionId` num banco (ex.: Vercel KV / Postgres)
   para entregar uma vez só.
2. **Imagens dos carrosséis** — `assets/slides/*.jpg` e `assets/professores/*.jpg`
   foram recortadas de capturas de tela. Troque pelos originais, com o mesmo nome.
3. **Depoimentos e avaliação** — mantenha só depoimentos reais, com autorização,
   e números reais de avaliações.
