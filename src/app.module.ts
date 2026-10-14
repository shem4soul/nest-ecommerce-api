import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import { AuthModule } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { CatalogModule } from './catalog/catalog.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { JwtAuthGuard, RolesGuard } from './common/guards';
import { Env, validateEnv } from './config/env';
import { HealthController } from './health/health.controller';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres' as const,
        url: config.get('DATABASE_URL', { infer: true }),
        autoLoadEntities: true,
        synchronize: false, // the schema is owned by migrations
        migrations: [join(__dirname, 'database', 'migrations', '*{.ts,.js}')],
        migrationsRun: config.get('RUN_MIGRATIONS', { infer: true }),
      }),
    }),
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }], skipIf: () => process.env.NODE_ENV === 'test' }),
    ScheduleModule.forRoot(),
    AuthModule,
    CatalogModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limit first, then "who are you", then "are you allowed".
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
