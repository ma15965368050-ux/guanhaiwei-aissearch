"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerShipsRoutes = registerShipsRoutes;
const pg_1 = require("../../db/pg");
async function registerShipsRoutes(app) {
    app.get('/api/ships/search', async (req, reply) => {
        const q = String(req.query.q || '').trim();
        if (!q) {
            return reply.code(400).send({
                ok: false,
                message: '缺少查询参数 q',
            });
        }
        const rs = await pg_1.pool.query(`
      select
        vls.mmsi,
        coalesce(v.vessel_name, '未知船舶') as name,
        coalesce(v.ship_type, '--') as type,
        coalesce(v.flag_country, '--') as flag,
        coalesce(vls.nav_status, '--') as status,
        vls.speed_knots as speed,
        vls.heading,
        coalesce(vls.destination, '--') as destination,
        vls.eta_utc as eta,
        vls.lat,
        vls.lng,
        vls.position_ts as "lastUpdate"
      from vessel_latest_state vls
      left join vessels v on v.mmsi = vls.mmsi
      where vls.mmsi = $1 or v.imo = $1
      limit 1
      `, [q]);
        if (rs.rowCount === 0) {
            return {
                ok: true,
                data: {
                    mmsi: q,
                    name: '未入库目标',
                    type: '--',
                    flag: '--',
                    status: '未开始跟踪',
                    speed: null,
                    heading: null,
                    destination: '--',
                    eta: null,
                    lat: 0,
                    lng: 0,
                    lastUpdate: null,
                    riskLevel: '低',
                    riskReason: '',
                },
            };
        }
        return {
            ok: true,
            data: {
                ...rs.rows[0],
                riskLevel: '低',
                riskReason: '',
            },
        };
    });
    app.get('/api/ships/:mmsi/latest', async (req) => {
        const { mmsi } = req.params;
        const rs = await pg_1.pool.query(`select * from vessel_latest_state where mmsi = $1`, [mmsi]);
        return {
            ok: true,
            data: rs.rows[0] || null,
        };
    });
    app.get('/api/ships/:mmsi/history', async (req) => {
        const { mmsi } = req.params;
        const hours = Number(req.query.hours || 24);
        const rs = await pg_1.pool.query(`
      select *
      from vessel_position_history
      where mmsi = $1
        and position_ts >= now() - ($2 || ' hours')::interval
      order by position_ts desc
      `, [mmsi, hours]);
        return {
            ok: true,
            data: rs.rows,
        };
    });
}
