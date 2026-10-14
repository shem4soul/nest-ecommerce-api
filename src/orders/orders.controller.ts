import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthUser, CurrentUser, Roles } from '../common/decorators';
import { PageQuery } from '../common/pagination';
import { PaymentsService } from '../payments/payments.service';
import { AdminListOrdersQuery, CheckoutDto, UpdateOrderStatusDto } from './dto/orders.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  /** Creates an order from the cart and starts a Paystack payment. Safe to retry with the same Idempotency-Key. */
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Any unique string (8-100 chars) per checkout attempt, e.g. a UUID' })
  @Post('checkout')
  async checkout(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CheckoutDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || key.length < 8 || key.length > 100) throw new BadRequestException('Send an Idempotency-Key header (8-100 characters)');

    const { orderId, replay } = await this.orders.checkout(user.id, key, dto);
    res.status(replay ? 200 : 201);
    if (replay) res.setHeader('Idempotent-Replay', 'true');

    // The order is already saved. If the provider is down the customer can retry via POST /orders/:id/pay.
    let payment: { reference: string; authorizationUrl: string } | null = null;
    let paymentError: string | undefined;
    try {
      payment = await this.payments.initializeForOrder(orderId, user.id);
    } catch (err) {
      paymentError = (err as Error).message;
    }
    return { order: await this.orders.get(orderId, user), payment, ...(paymentError ? { paymentError } : {}) };
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.orders.listMine(user.id, q.page, q.limit);
  }

  @Get(':id')
  one(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(id, user);
  }

  @HttpCode(200) @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.cancelMine(user.id, id);
  }

  @HttpCode(200) @Post(':id/pay')
  pay(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.initializeForOrder(id, user.id);
  }

  /** Use after the customer returns from Paystack if you haven't seen the webhook yet. */
  @HttpCode(200) @Post(':id/payment/verify')
  verify(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.verifyForOrder(id, user.id);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query() q: AdminListOrdersQuery) {
    return this.orders.adminList(q.status, q.page, q.limit);
  }

  @Get(':id')
  one(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(id, user);
  }

  @Patch(':id/status')
  updateStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.orders.adminUpdateStatus(user.id, id, dto.status, dto.note);
  }
}
