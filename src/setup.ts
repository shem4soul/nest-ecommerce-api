import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Shared by main.ts and the e2e tests so both run with identical validation rules. */
export function configureApp(app: INestApplication) {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // silently drop unknown properties
      forbidNonWhitelisted: true, // ...but reject the request if any were sent
      transform: true,
    }),
  );
}
