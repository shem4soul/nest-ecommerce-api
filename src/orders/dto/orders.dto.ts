import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, MaxLength, ValidateNested } from 'class-validator';
import { PageQuery } from '../../common/pagination';
import { OrderStatus } from '../order-status';

export class ShippingAddressDto {
  @IsString() @Length(2, 100) fullName: string;
  @IsString() @Length(7, 20) phone: string;
  @IsString() @Length(3, 200) line1: string;
  @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @IsString() @Length(2, 80) city: string;
  @IsString() @Length(2, 80) state: string;
  @IsOptional() @IsString() @Length(2, 2) country?: string;
}

export class CheckoutDto {
  @ValidateNested() @Type(() => ShippingAddressDto) shippingAddress: ShippingAddressDto;
}

const STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'EXPIRED'];

export class AdminListOrdersQuery extends PageQuery {
  @IsOptional() @IsEnum(STATUSES) status?: OrderStatus;
}

export class UpdateOrderStatusDto {
  @IsEnum(STATUSES) status: OrderStatus;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
