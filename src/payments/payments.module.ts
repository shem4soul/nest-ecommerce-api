import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { PaystackGateway } from './paystack.gateway';
import { WebhookController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [WebhookController],
  providers: [
    PaymentsService,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService],
      useFactory: (c: ConfigService<Env, true>) =>
        new PaystackGateway(c.get('PAYSTACK_SECRET_KEY', { infer: true }), c.get('PAYSTACK_BASE_URL', { infer: true })),
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
