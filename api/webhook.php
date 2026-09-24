<?php
declare(strict_types=1);

/**
 * Recebe as notificações da ZuckPay (campo urlnoty da cobrança).
 *
 * Duas camadas de verificação:
 *
 * 1. Assinatura HMAC do header X-ZuckPay-Signature, quando há webhook_secret
 *    configurado. Prova que o POST veio mesmo da ZuckPay.
 * 2. Reconsulta do status na API. Prova que o pagamento está realmente pago
 *    agora, independente do que o corpo do POST diz.
 *
 * O mesmo endpoint atende PIX, cartão, SPEI e PayPal.
 */

require __DIR__ . '/_bootstrap.php';

$config = carregarConfig();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    responder(405, ['erro' => 'Método não permitido.']);
}

// O corpo cru precisa ser lido antes de qualquer parse: o HMAC é calculado
// sobre os bytes exatos que chegaram.
$corpoRaw = (string) file_get_contents('php://input');

$segredo = (string) ($config['webhook_secret'] ?? '');
if ($segredo !== '') {
    $header = (string) ($_SERVER['HTTP_X_ZUCKPAY_SIGNATURE'] ?? '');
    [$valida, $motivo] = assinaturaWebhookValida($header, $corpoRaw, $segredo);

    if (!$valida) {
        registrarErro('webhook', 'assinatura recusada: ' . $motivo);
        responder(401, ['erro' => 'Assinatura inválida.']);
    }
} else {
    registrarErro('webhook', 'webhook_secret não configurado — validando só pela API');
}

$corpo = json_decode($corpoRaw, true);
$corpo = is_array($corpo) ? $corpo : [];

/**
 * A ZuckPay envia dois formatos:
 *
 * - Pagamento (PIX/cartão/PayPal): { event, platform, transaction: { id, ... } }
 * - SPEI:                          { transactionId, status, ... }  (plano)
 *
 * Aceitamos os dois para que um handler só cubra todos os métodos.
 */
$transacao = is_array($corpo['transaction'] ?? null) ? $corpo['transaction'] : [];

$transactionId = (string) (
    $transacao['id']
    ?? $corpo['transactionId']
    ?? $corpo['transaction_id']
    ?? ''
);

$evento = (string) ($corpo['event'] ?? '');

if ($transactionId === '' || !preg_match('/^[A-Za-z0-9._-]{8,128}$/', $transactionId)) {
    registrarErro('webhook', 'id ausente no payload: ' . substr($corpoRaw, 0, 300));
    responder(400, ['erro' => 'transactionId ausente ou inválido.']);
}

// Responde rápido para eventos que não exigem entrega, sem gastar uma
// chamada de API (a ZuckPay tem rate limit).
$eventosIgnorados = ['payment_refused', 'payment_pending', 'checkout_abandoned'];
if (in_array($evento, $eventosIgnorados, true)) {
    responder(200, ['ok' => true, 'ignorado' => $evento]);
}

// Confirma direto na fonte, ignorando o status que veio no POST.
[$status, $resposta] = chamarZuckpay(
    $config,
    'GET',
    '/status?transactionId=' . urlencode($transactionId)
);

if ($status !== 200 || !isset($resposta['status'])) {
    registrarErro('webhook', 'falha ao verificar ' . $transactionId . ' (HTTP ' . $status . ')');
    responder(502, ['erro' => 'Não foi possível verificar a transação.']);
}

if (strtoupper((string) $resposta['status']) !== 'PAID') {
    // Ainda não pago: responde 200 para a ZuckPay não ficar reenviando.
    responder(200, ['ok' => true, 'ignorado' => 'nao_pago']);
}

/**
 * Idempotência: a ZuckPay reenvia a mesma notificação. Só a primeira
 * gravação de cada transactionId prossegue para a entrega.
 */
$jaProcessado = transacaoJaRegistrada($config, $transactionId);

if (!$jaProcessado) {
    $externalId = (string) ($transacao['external_id_client'] ?? ($corpo['external_id_client'] ?? ''));
    $itens = itensDoPedido($config, $externalId);

    registrarPagamento($config, [
        'transactionId'      => $transactionId,
        'evento'             => $evento,
        'external_id_client' => $externalId,
        'plano'              => $itens['plano'],
        'bumps'              => $itens['bumps'],
        'nome'               => $transacao['nome'] ?? null,
        'email'              => $transacao['email'] ?? ($resposta['email'] ?? null),
        'valor'              => $resposta['amount'] ?? ($transacao['amount'] ?? null),
        'metodo'             => $resposta['payment_method'] ?? ($transacao['payment_method'] ?? null),
        'produto'            => $transacao['product_name'] ?? null,
        'confirmado_em'      => $resposta['confirmed_date'] ?? ($transacao['confirmed_date'] ?? null),
        'registrado_em'      => date('c'),
    ]);

    /*
     * TODO — entrega do produto.
     * Aqui entra o envio do e-mail com o link dos PDFs / liberação da área de
     * membros. Este bloco roda uma única vez por transactionId.
     * $itens['plano'] ("slides" ou "biobox") e $itens['bumps'] (ids do
     * config.php) dizem exatamente o que foi pago.
     */
}

responder(200, ['ok' => true, 'duplicado' => $jaProcessado]);
