"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const app_1 = require("./app");
const env_1 = require("./config/env");
const ships_routes_1 = require("./modules/ships/ships.routes");
const tracking_routes_1 = require("./modules/tracking/tracking.routes");
const broadcaster_1 = require("./modules/stream/broadcaster");
const aisstream_client_1 = require("./modules/stream/aisstream.client");
async function bootstrap() {
    const app = await (0, app_1.buildApp)();
    await (0, ships_routes_1.registerShipsRoutes)(app);
    const server = http_1.default.createServer(app.server);
    const broadcaster = new broadcaster_1.ShipBroadcaster(server);
    const aisClient = new aisstream_client_1.AisStreamClient(broadcaster);
    await (0, tracking_routes_1.registerTrackingRoutes)(app, aisClient);
    await app.ready();
    server.listen(env_1.env.PORT, () => {
        console.log(`Backend listening on http://localhost:${env_1.env.PORT}`);
    });
    await aisClient.start();
}
bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
});
