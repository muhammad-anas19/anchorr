import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // The dashboard (Frontend/) runs on its own origin/port — unlike the widget's own
  // narrower, per-workspace allowlist (Phase 11), this is the internal, JWT-authenticated
  // API surface, so a permissive dev CORS setup is enough for now.
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
