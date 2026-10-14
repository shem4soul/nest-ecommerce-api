import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrdersService } from './orders.service';

@Injectable()
export class ExpiryService {
  private readonly logger = new Logger(ExpiryService.name);
  constructor(private readonly orders: OrdersService) {}

  @Cron(CronExpression.EVERY_MINUTE, { disabled: process.env.NODE_ENV === 'test' })
  async sweep() {
    const expired = await this.orders.expireStale().catch((err) => {
      this.logger.error(`expiry sweep failed: ${err.message}`);
      return 0;
    });
    if (expired) this.logger.log(`expired ${expired} unpaid order(s) and released their stock`);
  }
}
