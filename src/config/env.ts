import 'dotenv/config';

function must(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return v;
}

export const env = {
  PORT: Number(process.env.PORT || 4001),
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
  DATABASE_URL: must('DATABASE_URL'),
  AISSTREAM_API_KEY: must('AISSTREAM_API_KEY'),
};