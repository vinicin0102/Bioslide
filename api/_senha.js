/**
 * Senha do painel (variável PAINEL_SENHA), enviada no header
 * Authorization: Bearer <senha>. Comparação em tempo constante.
 */
import crypto from 'node:crypto';

export function senhaConfere(request) {
    const senha = process.env.PAINEL_SENHA || '';
    const enviada = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!senha || !enviada) return false;
    const a = crypto.createHash('sha256').update(senha).digest();
    const b = crypto.createHash('sha256').update(enviada).digest();
    return crypto.timingSafeEqual(a, b);
}
