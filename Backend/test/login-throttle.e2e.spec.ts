import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.module';

describe('Login throttling (e2e)', () => {
  let app: INestApplication;
  let redis: Redis;
  const email = 'throttle-test@northwind.com';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    redis = moduleRef.get(REDIS_CLIENT);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const keys = await redis.keys(`login-attempts:${email}:*`);
    if (keys.length) {
      await redis.del(...keys);
    }
  });

  it('allows up to 5 login attempts per minute, then blocks the 6th with 429', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'wrong-password' })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(429);
  });

  // Premise first: the guard runs BEFORE LoginDto's @Transform, so if it keyed on the raw body,
  // every casing would get its own five attempts. This proves they share one counter.
  it('counts different capitalisations of one email against the same limit', async () => {
    const variants = [email, email.toUpperCase(), '  Throttle-Test@Northwind.com', 'THROTTLE-test@northwind.COM', email];
    for (const variant of variants) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: variant, password: 'wrong-password' })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'Throttle-Test@NORTHWIND.com', password: 'wrong-password' })
      .expect(429);
  });
});
