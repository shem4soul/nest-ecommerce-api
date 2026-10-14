import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail() email: string;
  @IsString() @MinLength(10) @MaxLength(100) password: string;
  @IsString() @MinLength(2) @MaxLength(100) name: string;
}

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @MaxLength(100) password: string;
}

export class RefreshDto {
  @IsString() @MinLength(20) @MaxLength(200) refreshToken: string;
}
