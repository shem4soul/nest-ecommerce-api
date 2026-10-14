import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer } from '../common/bigint.transformer';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) sku: string;
  @Column() name: string;
  @Column({ unique: true }) slug: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ name: 'price_kobo', type: 'bigint', transformer: bigintTransformer }) priceKobo: number;
  @Column({ default: 'NGN' }) currency: string;
  @Column({ name: 'stock_quantity', type: 'int', default: 0 }) stockQuantity: number;
  @Column({ name: 'category_id', type: 'uuid', nullable: true }) categoryId: string | null;
  @Column({ name: 'is_active', default: true }) isActive: boolean;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
  // The generated `search` tsvector column is queried in SQL only and deliberately not mapped here.
}
