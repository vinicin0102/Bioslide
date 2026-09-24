<?php
declare(strict_types=1);

/**
 * Utilitários compartilhados pelos endpoints da API.
 * Este arquivo não responde nada sozinho.
 */

function carregarConfig(): array
{
    $caminho = __DIR__ . '/config.php';
    if (!is_file($caminho)) {
        responder(500, ['erro' => 'Servidor não configurado.']);
    }
    return require $caminho;
}

function responder(int $status, array $dados): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($dados, JSON_UNESCAPED_UNICODE);
    exit;
}

function aplicarCors(array $config): void
{
    $origem = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origem !== '' && in_array($origem, $config['allowed_origins'], true)) {
        header('Access-Control-Allow-Origin: ' . $origem);
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Allow-Methods: POST, GET, OPTIONS');

    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function corpoJson(): array
{
    $bruto = file_get_contents('php://input');
    $dados = json_decode((string) $bruto, true);
    return is_array($dados) ? $dados : [];
}

/** Registra no log de erros do servidor, sem devolver detalhes ao cliente. */
function registrarErro(string $contexto, string $detalhe): void
{
    error_log(sprintf('[zuckpay][%s] %s', $contexto, $detalhe));
}

/** Valida CPF incluindo os dígitos verificadores. */
function cpfValido(string $cpf): bool
{
    if (strlen($cpf) !== 11 || preg_match('/^(\d)\1{10}$/', $cpf)) {
        return false;
    }
    for ($posicao = 9; $posicao < 11; $posicao++) {
        $soma = 0;
        for ($i = 0; $i < $posicao; $i++) {
            $soma += (int) $cpf[$i] * (($posicao + 1) - $i);
        }
        $digito = ((10 * $soma) % 11) % 10;
        if ((int) $cpf[$posicao] !== $digito) {
            return false;
        }
    }
    return true;
}

/**
 * Chamada autenticada à API da ZuckPay.
 * O client_secret nunca sai daqui — não é devolvido ao navegador em hipótese alguma.
 *
 * Redirecionamentos NÃO são seguidos de propósito: seguir um 3xx num POST
 * autenticado reenviaria o Authorization para o host de destino, e o corpo
 * costuma ser descartado no caminho. Em vez disso devolvemos o Location para
 * que o api_base seja corrigido.
 *
 * @return array{0:int,1:array,2:string} [status http, corpo decodificado, destino do redirect]
 */
function chamarZuckpay(array $config, string $metodo, string $caminho, ?array $payload = null): array
{
    $url = rtrim($config['api_base'], '/') . $caminho;
    $autorizacao = 'Basic ' . base64_encode($config['client_id'] . ':' . $config['client_secret']);

    $cabecalhos = ['Accept: application/json', 'Authorization: ' . $autorizacao];
    $ch = curl_init($url);
    $opcoes = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 25,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ];

    if ($metodo === 'POST') {
        $opcoes[CURLOPT_POST] = true;
        $opcoes[CURLOPT_POSTFIELDS] = json_encode($payload, JSON_UNESCAPED_UNICODE);
        $cabecalhos[] = 'Content-Type: application/json';
    }

    $opcoes[CURLOPT_HTTPHEADER] = $cabecalhos;
    $opcoes[CURLOPT_HEADER] = true;
    curl_setopt_array($ch, $opcoes);

    $bruto    = curl_exec($ch);
    $status   = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $tamCab   = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $erroCurl = curl_error($ch);
    curl_close($ch);

    if ($bruto === false) {
        registrarErro('curl', $erroCurl);
        return [0, [], ''];
    }

    $cabecalhosResposta = substr((string) $bruto, 0, $tamCab);
    $resposta           = substr((string) $bruto, $tamCab);

    $destino = '';
    if ($status >= 300 && $status < 400
        && preg_match('/^Location:\s*(.+)$/mi', $cabecalhosResposta, $m)) {
        $destino = trim($m[1]);
        registrarErro('redirect', 'HTTP ' . $status . ' -> ' . $destino);
    }

    $decodificado = json_decode($resposta, true);
    if (!is_array($decodificado)) {
        registrarErro('resposta', 'HTTP ' . $status . ' com corpo não-JSON');
        return [$status, [], $destino];
    }

    return [$status, $decodificado, $destino];
}

/**
 * Valida o header X-ZuckPay-Signature.
 *
 * Formato: t=<timestamp>,v1=<hmac_sha256_hex>
 * Cálculo:  HMAC-SHA256("<timestamp>.<corpo_raw>", webhook_secret)
 *
 * @return array{0:bool,1:string} [válida, motivo da recusa]
 */
function assinaturaWebhookValida(string $header, string $corpoRaw, string $segredo): array
{
    if ($header === '') {
        return [false, 'header X-ZuckPay-Signature ausente'];
    }

    parse_str(strtr($header, ',', '&'), $partes);
    $ts = (string) ($partes['t'] ?? '');
    $v1 = (string) ($partes['v1'] ?? '');

    if ($ts === '' || $v1 === '' || !ctype_digit($ts)) {
        return [false, 'header malformado'];
    }

    // Anti-replay: rejeita assinaturas velhas ou com data no futuro.
    if (abs(time() - (int) $ts) > 300) {
        return [false, 'timestamp fora da janela de 5 minutos'];
    }

    $esperado = hash_hmac('sha256', $ts . '.' . $corpoRaw, $segredo);

    if (!hash_equals($esperado, $v1)) {
        return [false, 'assinatura não confere'];
    }

    return [true, ''];
}

/** Diretório de estado (cache e registro de vendas). */
function diretorioEstado(array $config): string
{
    $dir = dirname((string) ($config['log_path'] ?? __DIR__ . '/../storage/pagamentos.log'));
    if (!is_dir($dir)) {
        @mkdir($dir, 0770, true);
    }
    return $dir;
}

/**
 * Cache curto das consultas de status.
 *
 * A ZuckPay aplica rate limit (429). Como a página consulta em intervalos
 * curtos enquanto o comprador paga, várias abas ou recarregamentos poderiam
 * estourar o limite. Guardamos a última resposta por alguns segundos.
 *
 * @return array|null resposta em cache, ou null se não houver/estiver velha
 */
function cacheStatusLer(array $config, string $transactionId, int $validadeSegundos = 8): ?array
{
    $arquivo = diretorioEstado($config) . '/status-' . sha1($transactionId) . '.json';

    if (!is_file($arquivo) || (time() - (int) filemtime($arquivo)) > $validadeSegundos) {
        return null;
    }

    $dados = json_decode((string) @file_get_contents($arquivo), true);
    return is_array($dados) ? $dados : null;
}

function cacheStatusGravar(array $config, string $transactionId, array $dados): void
{
    $arquivo = diretorioEstado($config) . '/status-' . sha1($transactionId) . '.json';
    @file_put_contents($arquivo, json_encode($dados, JSON_UNESCAPED_UNICODE), LOCK_EX);
}

/**
 * Idempotência da entrega: diz se este transactionId já foi registrado.
 *
 * A ZuckPay reenvia a mesma notificação, então a entrega do produto precisa
 * acontecer uma única vez. Usa um arquivo-marcador criado atomicamente:
 * duas notificações simultâneas não conseguem passar as duas.
 */
function transacaoJaRegistrada(array $config, string $transactionId): bool
{
    $marcador = diretorioEstado($config) . '/pago-' . sha1($transactionId) . '.flag';

    // 'x' falha se o arquivo já existir — é o teste e a criação num passo só.
    $handle = @fopen($marcador, 'x');

    if ($handle === false) {
        return true;
    }

    fwrite($handle, date('c'));
    fclose($handle);
    return false;
}

/** Acrescenta a venda ao log de pagamentos. */
function registrarPagamento(array $config, array $dados): void
{
    diretorioEstado($config);
    @file_put_contents(
        (string) $config['log_path'],
        json_encode($dados, JSON_UNESCAPED_UNICODE) . PHP_EOL,
        FILE_APPEND | LOCK_EX
    );
}

/**
 * Lê plano e bumps do external_id_client (BS-<plano>-<códigos>-<pedido>),
 * para o webhook saber o que entregar.
 *
 * @return array{plano:string,bumps:string[]} ids do plano e dos bumps
 */
function itensDoPedido(array $config, string $externalId): array
{
    if (!preg_match('/^BS-([a-z]+)-([a-z0-9]+)-/', $externalId, $m)) {
        return ['plano' => '', 'bumps' => []];
    }

    $bumps = [];
    foreach ((array) ($config['bumps'] ?? []) as $bumpId => $bump) {
        if ($m[2] !== '0' && str_contains($m[2], (string) ($bump['codigo'] ?? '#'))) {
            $bumps[] = $bumpId;
        }
    }

    return ['plano' => $m[1], 'bumps' => $bumps];
}
