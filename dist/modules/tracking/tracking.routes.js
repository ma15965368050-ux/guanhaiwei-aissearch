"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTrackingRoutes = registerTrackingRoutes;
const pg_1 = require("../../db/pg");
async function registerTrackingRoutes(app, aisClient) {
    app.post('/api/tracking/start', async (req, reply) => {
        const body = req.body;
        const mmsi = String(body?.mmsi || '').trim();
        if (!mmsi) {
            return reply.code(400).send({
                ok: false,
                message: 'mmsi 必填',
            });
        }
        await pg_1.pool.query(`
      insert into active_watchlist (mmsi, watch_reason, status, updated_at)
      values ($1, $2, 'active', now())
      on conflict do nothing
      `, [mmsi, body.watchReason || 'manual start']);
        await aisClient.reloadTrackedMmsi();
        return {
            ok: true,
            data: {
                mmsi,
                tracking: true,
            },
        };
    });
    app.post('/api/tracking/stop', async (req, reply) => {
        const body = req.body;
        const mmsi = String(body?.mmsi || '').trim();
        if (!mmsi) {
            return reply.code(400).send({
                ok: false,
                message: 'mmsi 必填',
            });
        }
        await pg_1.pool.query(`
      update active_watchlist
      set status = 'stopped', updated_at = now()
      where mmsi = $1 and status = 'active'
      `, [mmsi]);
        await aisClient.reloadTrackedMmsi();
        return {
            ok: true,
            data: {
                mmsi,
                tracking: false,
            },
        };
    });
}
