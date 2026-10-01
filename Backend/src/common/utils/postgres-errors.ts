
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const driverError = (error as { driverError?: { code?: string; constraint?: string } }).driverError;
  return driverError?.code === '23505' && driverError.constraint === constraint;
}
