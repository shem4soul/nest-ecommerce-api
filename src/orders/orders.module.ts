import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ExpiryService } from './expiry.service';
import { AdminOrdersController, OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService, ExpiryService],
  exports: [OrdersService],
})
export class OrdersModule {}
