import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { Env } from './config/env';
import { configureApp } from './setup';

async function bootstrap() {
  // rawBody: the Paystack webhook signature is computed over the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService<Env, true>);

  app.use(helmet());
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  configureApp(app);
  app.enableShutdownHooks();

  if (config.get('NODE_ENV', { infer: true }) !== 'production' || config.get('ENABLE_DOCS', { infer: true })) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Nest E-commerce API').setVersion('1.0').addBearerAuth().build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  new Logger('Bootstrap').log(`API on :${port}${config.get('NODE_ENV', { infer: true }) !== 'production' ? `, docs at /docs` : ''}`);
}
bootstrap();
