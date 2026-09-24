<?php
declare(strict_types=1);

/**
 * Testa a validação de assinatura do webhook em produção.
 *
 * Monta um POST assinado exatamente como a ZuckPay faz e envia para a sua
 * própria webhook_url, provando que a verificação HMAC está funcionando.
 *
 * Uso (no servidor, via terminal):
 *   php tools/testar-webhook.php
 *   php tools/testar-webhook.php TRANSACTION_ID_REAL
 *
 * O segredo é lido do config.php — nunca passe ele por argumento, porque a
 * linha de comando fica visível para outros processos e no histórico do shell.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit("Este script só roda pela linha de comando.\n");
}

$config = require __DIR__ . '/../api/config.php';

$segredo = (string) ($config['webhook_secret'] ?? '');
$url     = (string) ($config['webhook_url'] ?? '');

if ($segredo === '') {
    exit("ERRO: webhook_secret está vazio no config.php.\n"
       . "Gere um no painel em Integrações > Webhook Secret.\n");
}
if ($url === '' || str_contains($url, 'SEU-DOMINIO')) {
    exit("ERRO: webhook_url não foi configurada no config.php.\n");
}

$transactionId = $argv[1] ?? 'TESTE0000000000000000000';

echo "Webhook:  {$url}\n";
echo "Segredo:  " . substr($segredo, 0, 8) . str_repeat('*', 8) . " (" . strlen($segredo) . " chars)\n";
echo "Transação: {$transactionId}\n\n";

/** Envia um POST com o header de assinatura informado. */
function enviar(string $url, string $corpo, string $assinatura): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $corpo,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'X-ZuckPay-Signature: ' . $assinatura,
        ],
    ]);
    $resposta = curl_exec($ch);
    $status   = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $erro     = curl_error($ch);
    curl_close($ch);

    return [$status, $resposta === false ? $erro : (string) $resposta];
}

function assinar(string $corpo, string $segredo, int $timestamp): string
{
    return 't=' . $timestamp . ',v1=' . hash_hmac('sha256', $timestamp . '.' . $corpo, $segredo);
}

$corpo = json_encode([
    'transactionId' => $transactionId,
    'status'        => 'PAID',
    'amount'        => 29.90,
], JSON_UNESCAPED_UNICODE);

$agora = time();

$casos = [
    'assinatura válida        (esperado: 200)' => assinar($corpo, $segredo, $agora),
    'assinatura falsa         (esperado: 401)' => 't=' . $agora . ',v1=' . str_repeat('0', 64),
    'replay de 10 minutos     (esperado: 401)' => assinar($corpo, $segredo, $agora - 600),
    'sem header de assinatura (esperado: 401)' => '',
];

$ok = true;

foreach ($casos as $rotulo => $assinatura) {
    [$status, $resposta] = enviar($url, $corpo, $assinatura);
    $esperado = str_contains($rotulo, '200') ? 200 : 401;
    $passou   = $status === $esperado;
    $ok       = $ok && $passou;

    printf("%s  %s -> HTTP %d %s\n", $passou ? '[ok] ' : '[FALHOU]', $rotulo, $status,
        $passou ? '' : '| resposta: ' . substr(trim($resposta), 0, 120));
}

echo "\n";

if ($ok) {
    echo "Tudo certo: o webhook aceita apenas notificações assinadas pela ZuckPay.\n";
    echo "Obs.: o caso válido responde 200 mesmo com transactionId de teste porque\n";
    echo "o handler reconsulta o status na API e ignora o que não está pago.\n";
} else {
    echo "Algo falhou. Verifique:\n";
    echo "  - o webhook_secret do config.php é o mesmo gerado no painel;\n";
    echo "  - a webhook_url é acessível publicamente (sem senha, sem bloqueio);\n";
    echo "  - o servidor entrega o header X-ZuckPay-Signature ao PHP.\n";
}

exit($ok ? 0 : 1);
