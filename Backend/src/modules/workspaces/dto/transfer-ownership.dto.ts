import { IsInt, IsPositive } from 'class-validator';

export class TransferOwnershipDto {
  @IsInt()
  @IsPositive()
  userId!: number;
}
