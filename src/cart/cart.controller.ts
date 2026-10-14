import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators';
import { CartService } from './cart.service';

class SetQuantityDto {
  @IsInt() @Min(1) @Max(99) quantity: number;
}

@ApiTags('cart')
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.cart.get(user.id);
  }

  @Put('items/:productId')
  set(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string, @Body() dto: SetQuantityDto) {
    return this.cart.setItem(user.id, productId, dto.quantity);
  }

  @Delete('items/:productId')
  remove(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.cart.removeItem(user.id, productId);
  }

  @HttpCode(204) @Delete()
  async clear(@CurrentUser() user: AuthUser) {
    await this.cart.clear(user.id);
  }
}
