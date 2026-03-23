import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: [env.FRONTEND_ORIGIN],
    credentials: true,
  });

  return app;
}