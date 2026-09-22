// The Backend's own base URL — same one the Widget package points at, just for the
// authenticated dashboard side instead of the public widget surface.
export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:3001';
