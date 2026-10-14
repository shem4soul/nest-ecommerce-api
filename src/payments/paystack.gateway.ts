import { BadGatewayException } from '@nestjs/common';
import { PaymentGateway } from './payment-gateway';

export class PaystackGateway implements PaymentGateway {
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BadGatewayException('Payment provider is unreachable');
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.status === false) throw new BadGatewayException(json.message ?? 'Payment provider rejected the request');
    return json.data;
  }

  async initialize({ email, amountKobo, reference, callbackUrl }: Parameters<PaymentGateway['initialize']>[0]) {
    const data = await this.call('POST', '/transaction/initialize', {
      email,
      amount: amountKobo,
      currency: 'NGN',
      reference,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    });
    return { authorizationUrl: data.authorization_url as string };
  }

  async verify(reference: string) {
    const data = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    const status = data.status === 'success' ? 'success' : ['failed', 'abandoned', 'reversed'].includes(data.status) ? 'failed' : 'pending';
    return { status, amountKobo: Number(data.amount), currency: String(data.currency) } as const;
  }
}
