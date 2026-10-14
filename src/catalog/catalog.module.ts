import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminProductsController, CategoriesController, ProductsController } from './catalog.controller';
import { Category } from './category.entity';
import { Product } from './product.entity';
import { ProductsService } from './products.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product, Category])],
  controllers: [ProductsController, AdminProductsController, CategoriesController],
  providers: [ProductsService],
})
export class CatalogModule {}
