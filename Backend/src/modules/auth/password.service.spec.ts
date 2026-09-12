import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces a hash that verifies against the original password', async () => {
    const hash = await service.hash('correct-horse-battery-staple');
    await expect(service.compare('correct-horse-battery-staple', hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await service.hash('correct-horse-battery-staple');
    await expect(service.compare('wrong-password', hash)).resolves.toBe(false);
  });

  it('produces a different hash for the same password each time (salting)', async () => {
    const hashA = await service.hash('same-password');
    const hashB = await service.hash('same-password');
    expect(hashA).not.toEqual(hashB);
  });
});
