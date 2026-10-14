import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { rowsOf } from '../common/rows';
import { Env } from '../config/env';
import { User } from '../users/user.entity';
import { LoginDto, RegisterDto } from './dto/auth.dto';

// Compared against when the email is unknown, so timing doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    if (await this.users.exist({ where: { email } })) throw new ConflictException('That email is already registered');
    const user = await this.users.save(
      this.users.create({ email, name: dto.name.trim(), passwordHash: await bcrypt.hash(dto.password, 10), role: 'CUSTOMER' }),
    );
    return { user: this.present(user), ...(await this.issueTokens(user)) };
  }

  async login(dto: LoginDto) {
    const user = await this.users.findOne({ where: { email: dto.email.toLowerCase() } });
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || !user.isActive) throw new UnauthorizedException('Invalid email or password');
    return { user: this.present(user), ...(await this.issueTokens(user)) };
  }

  /**
   * Rotation: each refresh token works once. Claiming it is a single conditional UPDATE, so two
   * simultaneous refreshes can't both succeed. A token that was already used means it leaked or was
   * replayed, so the whole family of tokens from that login is revoked.
   */
  async refresh(refreshToken: string) {
    const hash = sha256(refreshToken);
    const claimed = rowsOf<{ user_id: string; family_id: string }>(await this.ds.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING user_id, family_id`,
      [hash],
    ));
    if (!claimed[0]) {
      const known = await this.ds.query(`SELECT family_id FROM refresh_tokens WHERE token_hash = $1`, [hash]);
      if (known[0]) await this.ds.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [known[0].family_id]);
      throw new UnauthorizedException('Invalid refresh token');
    }
    const user = await this.users.findOne({ where: { id: claimed[0].user_id } });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid refresh token');
    return this.issueTokens(user, claimed[0].family_id);
  }

  async logout(refreshToken: string) {
    await this.ds.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
      [sha256(refreshToken)],
    );
  }

  async me(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.present(user);
  }

  private async issueTokens(user: User, familyId: string = crypto.randomUUID()) {
    const accessToken = await this.jwt.signAsync({ role: user.role }, { subject: user.id });
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    const days = this.config.get('REFRESH_TTL_DAYS', { infer: true });
    await this.ds.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
      [user.id, familyId, sha256(refreshToken), String(days)],
    );
    return { accessToken, refreshToken };
  }

  private present(u: User) {
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  }
}
