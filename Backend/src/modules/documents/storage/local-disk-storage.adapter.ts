import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { StorageAdapter } from './storage-adapter.interface';

@Injectable()
export class LocalDiskStorageAdapter implements StorageAdapter {
  private readonly baseDir: string;

  constructor(configService: ConfigService) {
    this.baseDir = configService.get<string>('STORAGE_DIR') ?? join(process.cwd(), 'storage');
  }

  async save(key: string, data: Buffer): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(join(this.baseDir, key), data);
  }

  read(key: string): Promise<Buffer> {
    return readFile(join(this.baseDir, key));
  }

  async delete(key: string): Promise<void> {
    await rm(join(this.baseDir, key), { force: true });
  }
}
