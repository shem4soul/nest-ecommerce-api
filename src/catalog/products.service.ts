import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import crypto from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { pageMeta } from '../common/pagination';
import { rowsOf } from '../common/rows';
import { CreateProductDto, ListProductsQuery, ProductSort, UpdateProductDto } from './dto/catalog.dto';
import { Product } from './product.entity';

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  present(p: Product, admin = false) {
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      slug: p.slug,
      description: p.description,
      priceKobo: p.priceKobo,
      currency: p.currency,
      inStock: p.stockQuantity > 0,
      categoryId: p.categoryId,
      ...(admin ? { stockQuantity: p.stockQuantity, isActive: p.isActive } : {}),
    };
  }

  async create(dto: CreateProductDto, actorId: string) {
    if (await this.products.exist({ where: { sku: dto.sku } })) throw new ConflictException('That SKU already exists');
    const created = await this.ds.transaction(async (m) => {
      let slug = slugify(dto.name);
      if (await m.exists(Product, { where: { slug } })) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
      const product = await m.save(
        m.create(Product, {
          sku: dto.sku,
          name: dto.name.trim(),
          slug,
          description: dto.description ?? null,
          priceKobo: dto.priceKobo,
          stockQuantity: dto.stockQuantity ?? 0,
          categoryId: dto.categoryId ?? null,
          isActive: dto.isActive ?? true,
        }),
      );
      if (product.stockQuantity > 0) {
        await m.query(
          `INSERT INTO stock_movements (product_id, delta, reason, actor_id) VALUES ($1, $2, 'INITIAL', $3)`,
          [product.id, product.stockQuantity, actorId],
        );
      }
      return product;
    });
    return this.present(created, true);
  }

  async update(id: string, dto: UpdateProductDto) {
    const product = await this.products.findOne({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    const { name, description, priceKobo, categoryId, isActive } = dto;
    if (name !== undefined) product.name = name.trim();
    if (description !== undefined) product.description = description;
    if (priceKobo !== undefined) product.priceKobo = priceKobo; // existing orders keep the price they were placed at
    if (categoryId !== undefined) product.categoryId = categoryId;
    if (isActive !== undefined) product.isActive = isActive;
    return this.present(await this.products.save(product), true);
  }

  async deactivate(id: string) {
    const res = await this.products.update({ id }, { isActive: false });
    if (!res.affected) throw new NotFoundException('Product not found');
  }

  async findOne(id: string) {
    const product = await this.products.findOne({ where: { id, isActive: true } });
    if (!product) throw new NotFoundException('Product not found');
    return this.present(product);
  }

  async list(query: ListProductsQuery, admin = false) {
    const qb = this.products.createQueryBuilder('p');
    if (!admin) qb.andWhere('p.is_active = TRUE');
    if (query.categoryId) qb.andWhere('p.category_id = :cat', { cat: query.categoryId });
    if (query.minPrice !== undefined) qb.andWhere('p.price_kobo >= :min', { min: query.minPrice });
    if (query.maxPrice !== undefined) qb.andWhere('p.price_kobo <= :max', { max: query.maxPrice });
    if (query.inStock) qb.andWhere('p.stock_quantity > 0');

    const searching = !!query.q?.trim();
    if (searching) {
      // websearch_to_tsquery accepts plain user input safely: quotes, "or" and -exclusions all work.
      qb.andWhere(`p.search @@ websearch_to_tsquery('english', :q)`, { q: query.q!.trim() });
    }

    const sort = query.sort ?? (searching ? ProductSort.RELEVANCE : ProductSort.NEWEST);
    if (sort === ProductSort.RELEVANCE && searching) {
      qb.orderBy(`ts_rank(p.search, websearch_to_tsquery('english', :q))`, 'DESC').addOrderBy('p.created_at', 'DESC');
    } else if (sort === ProductSort.PRICE_ASC) qb.orderBy('p.price_kobo', 'ASC').addOrderBy('p.id', 'ASC');
    else if (sort === ProductSort.PRICE_DESC) qb.orderBy('p.price_kobo', 'DESC').addOrderBy('p.id', 'ASC');
    else qb.orderBy('p.created_at', 'DESC').addOrderBy('p.id', 'ASC');

    const [rows, total] = await qb.skip((query.page - 1) * query.limit).take(query.limit).getManyAndCount();
    return { data: rows.map((p) => this.present(p, admin)), meta: pageMeta(query.page, query.limit, total) };
  }

  /** Atomic: the conditional UPDATE refuses to take stock below zero even under concurrent calls. */
  async adjustStock(id: string, delta: number, reason: string, actorId: string) {
    return this.ds.transaction(async (m) => {
      const rows = rowsOf<{ stock_quantity: number }>(
        await m.query(
          `UPDATE products SET stock_quantity = stock_quantity + $2, updated_at = now()
            WHERE id = $1 AND stock_quantity + $2 >= 0 RETURNING stock_quantity`,
          [id, delta],
        ),
      );
      if (!rows[0]) {
        if (!(await m.exists(Product, { where: { id } }))) throw new NotFoundException('Product not found');
        throw new ConflictException('Adjustment would make stock negative');
      }
      await m.query(
        `INSERT INTO stock_movements (product_id, delta, reason, ref_type, actor_id) VALUES ($1, $2, $3, 'ADJUSTMENT', $4)`,
        [id, delta, reason, actorId],
      );
      return { productId: id, stockQuantity: rows[0].stock_quantity };
    });
  }
}
