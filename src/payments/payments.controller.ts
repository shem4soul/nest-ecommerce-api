import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../common/decorators';
import { PaymentsService } from './payments.service';

@ApiExcludeController()
@Controller('payments/webhooks')
export class WebhookController {
  constructor(private readonly payments: PaymentsService) {}

  /** Needs the raw bytes: the app is created with rawBody enabled so the signature can be checked. */
  @Public() @SkipThrottle() @HttpCode(200) @Post('paystack')
  async paystack(@Req() req: RawBodyRequest<Request>, @Headers('x-paystack-signature') signature?: string) {
    if (!req.rawBody) throw new UnauthorizedException('Missing body');
    const outcome = await this.payments.handleWebhook(req.rawBody, signature);
    return { received: true, outcome };
  }
}
