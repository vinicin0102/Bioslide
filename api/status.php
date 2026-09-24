<?php
declare(strict_types=1);

/**
 * Consulta o status de uma cobrança.
 * GET ?transactionId=...  ->  { status, pago, confirmado_em, proxima_consulta }
 *
 * Serve PIX, cartão, SPEI e PayPal — a ZuckPay usa o mesmo endpoint de status.
 */

require __DIR__ . '/_bootstrap.php';

$config = carregarConfig();
aplicarCors($config);

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    responder(405, ['erro' => 'Método não permitido.']);
}

$transactionId = (string) ($_GET['transactionId'] ?? '');
if ($transactionId === '' || !preg_match('/^[A-Za-z0-9._-]{8,128}$/', $transactionId)) {
    responder(400, ['erro' => 'transactionId inválido.']);
}

// Evita repetir a chamada à ZuckPay quando várias consultas chegam juntas.
$cache = cacheStatusLer($config, $transactionId);
if ($cache !== null) {
    responder(200, $cache + ['cache' => true]);
}

[$status, $resposta] = chamarZuckpay(
    $config,
    'GET',
    '/status?transactionId=' . urlencode($transactionId)
);

// 429 = rate limit da ZuckPay. Pede à página para consultar mais devagar.
if ($status === 429) {
    registrarErro('status', 'rate limit ao consultar ' . $transactionId);
    responder(200, [
        'status'           => 'PENDING',
        'pago'             => false,
        'confirmado_em'    => '',
        'proxima_consulta' => 30,
    ]);
}

if ($status !== 200 || !isset($resposta['status'])) {
    registrarErro('status', 'HTTP ' . $status . ' para ' . $transactionId);
    responder(502, ['erro' => 'Não foi possível consultar o pagamento.']);
}

$situacao = strtoupper((string) $resposta['status']);

// Só o essencial. Valores e dados do comprador não voltam para o navegador.
$saida = [
    'status'           => $situacao,
    'pago'             => $situacao === 'PAID',
    'final'            => in_array($situacao, ['PAID', 'FAILED', 'REFUSED', 'EXPIRADO', 'REFUNDED'], true),
    'confirmado_em'    => (string) ($resposta['confirmed_date'] ?? ''),
    'proxima_consulta' => 5,
];

cacheStatusGravar($config, $transactionId, $saida);

responder(200, $saida);
