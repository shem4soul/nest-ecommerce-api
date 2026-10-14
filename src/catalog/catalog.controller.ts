import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { AuthUser, CurrentUser, Public, Roles } from '../common/decorators';
import { Category } from './category.entity';
import { CreateCategoryDto, CreateProductDto, ListProductsQuery, StockAdjustmentDto, UpdateProductDto } from './dto/catalog.dto';
import { ProductsService, slugify } from './products.service';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Public() @Get()
  list(@Query() query: ListProductsQuery) {
    return this.products.list(query);
  }

  @Public() @Get(':id')
  one(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.findOne(id);
  }

  @ApiBearerAuth() @Roles('ADMIN') @Post()
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.products.create(dto, user.id);
  }

  @ApiBearerAuth() @Roles('ADMIN') @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  /** Soft delete: past orders keep pointing at the product. */
  @ApiBearerAuth() @Roles('ADMIN') @HttpCode(204) @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.products.deactivate(id);
  }

  @ApiBearerAuth() @Roles('ADMIN') @Post(':id/stock-adjustments')
  adjust(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StockAdjustmentDto, @CurrentUser() user: AuthUser) {
    return this.products.adjustStock(id, dto.delta, dto.reason, user.id);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  /** Includes inactive products and exact stock levels. */
  @Get()
  list(@Query() query: ListProductsQuery) {
    return this.products.list(query, true);
  }
}

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(@InjectRepository(Category) private readonly categories: Repository<Category>) {}

  @Public() @Get()
  async list() {
    return { data: await this.categories.find({ order: { name: 'ASC' } }) };
  }

  @ApiBearerAuth() @Roles('ADMIN') @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.save(this.categories.create({ name: dto.name.trim(), slug: slugify(dto.name), parentId: dto.parentId ?? null }));
  }
}
