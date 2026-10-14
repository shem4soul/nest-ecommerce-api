import { OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageQuery } from '../../common/pagination';

export class CreateProductDto {
  @IsString() @Matches(/^[A-Za-z0-9._-]{3,40}$/, { message: 'sku must be 3-40 characters: letters, digits, . _ -' }) sku: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  /** Price in kobo (1 naira = 100 kobo). */
  @IsInt() @Min(0) @Max(100_000_000_000) priceKobo: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) stockQuantity?: number;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// Stock is deliberately not editable here: it only changes through stock adjustments and orders, so every change is in the ledger.
export class UpdateProductDto extends PartialType(OmitType(CreateProductDto, ['stockQuantity', 'sku'] as const)) {}

export class StockAdjustmentDto {
  @IsInt() @Min(-1_000_000) @Max(1_000_000) delta: number;
  @IsString() @MinLength(3) @MaxLength(200) reason: string;
}

export class CreateCategoryDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsOptional() @IsUUID() parentId?: string;
}

export enum ProductSort {
  NEWEST = 'newest',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
  RELEVANCE = 'relevance',
}

export class ListProductsQuery extends PageQuery {
  /** Full-text search over name and description. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minPrice?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxPrice?: number;
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() inStock?: boolean;
  @IsOptional() @IsEnum(ProductSort) sort?: ProductSort;
}
