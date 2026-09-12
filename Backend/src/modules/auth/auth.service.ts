import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { User } from '../../database/entities/user.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { Membership } from '../../database/entities/membership.entity';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { PasswordService } from './password.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<TokenPair> {
    const existing = await this.users.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await this.passwordService.hash(dto.password);
    const user = await this.users.save({ email: dto.email, passwordHash });
    const workspace = await this.workspaces.save({ name: dto.workspaceName });
    await this.memberships.save({
      userId: user.id,
      workspaceId: workspace.id,
      role: MembershipRole.OWNER,
    });

    return this.issueTokenPair(user.id);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.users.findOne({ where: { email: dto.email } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const passwordMatches = await this.passwordService.compare(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    return this.issueTokenPair(user.id);
  }

  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    let userId: number;
    try {
      const payload = await this.jwtService.verifyAsync<{ sub: number }>(rawRefreshToken, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      userId = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    const tokenHash = this.hashToken(rawRefreshToken);
    const storedToken = await this.refreshTokens.findOne({
      where: { userId, tokenHash },
    });

    if (!storedToken || storedToken.revokedAt || storedToken.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    storedToken.revokedAt = new Date();
    await this.refreshTokens.save(storedToken);

    return this.issueTokenPair(userId);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawRefreshToken);
    await this.refreshTokens.update({ tokenHash }, { revokedAt: new Date() });
  }

  private async issueTokenPair(userId: number): Promise<TokenPair> {
    const accessToken = await this.jwtService.signAsync(
      { sub: userId },
      { expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') },
    );

    const refreshTokenId = randomUUID();
    const refreshExpiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRES_IN')!;
    const refreshToken = await this.jwtService.signAsync(
      { sub: userId, jti: refreshTokenId },
      { expiresIn: refreshExpiresIn },
    );

    await this.refreshTokens.save({
      userId,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: this.addDuration(new Date(), refreshExpiresIn),
    });

    return { accessToken, refreshToken };
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private addDuration(from: Date, duration: string): Date {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) {
      throw new Error(`Unsupported duration format: ${duration}`);
    }
    const amount = Number(match[1]);
    const unit = match[2];
    const msPerUnit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return new Date(from.getTime() + amount * msPerUnit[unit]);
  }
}
