import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) name: string;
  @Column({ unique: true }) slug: string;
  @Column({ name: 'parent_id', type: 'uuid', nullable: true }) parentId: string | null;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
