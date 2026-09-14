import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { Workspace } from './entities/workspace.entity';
import { User } from './entities/user.entity';
import { Membership } from './entities/membership.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { Document } from './entities/document.entity';

config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [Workspace, User, Membership, RefreshToken, Document],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
});
