import { BadRequestException } from '@nestjs/common';

const KEY_SHAPE = /^[A-Za-z0-9_\-.:]{1,100}$/;

export function scopedIdempotencyKey(scope: string, raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!KEY_SHAPE.test(raw)) {
    throw new BadRequestException('Idempotency-Key must be 1-100 characters of letters, digits, "-", "_", ".", ":".');
  }
  return `${scope}:${raw}`;
}
