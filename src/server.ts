import { buildApp } from './app';
import { env } from './config/env';
import { registerShipsRoutes } from './modules/ships/ships.routes';
import { registerTrackingRoutes } from './modules/tracking/tracking.routes';
import { ShipBroadcaster } from './modules/stream/broadcaster';
import { AisStreamClient } from './modules/stream/aisstream.client';

async function bootstrap() {
  const app = await buildApp();

  await registerShipsRoutes(app);
  await app.register(async (instance) => {
    const broadcaster = new ShipBroadcaster(instance.server);
    const aisClient = new AisStreamClient(broadcaster);
    await registerTrackingRoutes(instance, aisClient);

    instance.addHook('onReady', async () => {
      await aisClient.start();
    });
  });

  await app.listen({
    port: env.PORT,
    host: '0.0.0.0',
  });

  console.log(`Backend listening on http://localhost:${env.PORT}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});