import { FastifyInstance } from 'fastify';
import { pool } from '../../db/pg';

function isMmsi(q: string) {
  return /^\d{9}$/.test(q);
}

function isImo(q: string) {
  return /^\d{7}$/.test(q);
}

export async function registerShipsRoutes(app: FastifyInstance) {
  app.get('/api/ships/search', async (req, reply) => {
    const q = String((req.query as any).q || '').trim();

    if (!q) {
      return reply.code(400).send({
        ok: false,
        message: '缺少查询参数 q',
      });
    }

    let rs;

    if (isMmsi(q)) {
      rs = await pool.query(
        `
        select
          v.mmsi,
          v.imo,
          coalesce(v.vessel_name, '未知船舶') as name,
          coalesce(v.ship_type, '--') as type,
          coalesce(v.flag_country, '--') as flag,
          coalesce(vls.nav_status, '未开始跟踪') as status,
          vls.speed_knots as speed,
          vls.heading,
          coalesce(vls.destination, '--') as destination,
          vls.eta_utc as eta,
          coalesce(vls.lat, 0) as lat,
          coalesce(vls.lng, 0) as lng,
          vls.position_ts as "lastUpdate"
        from vessels v
        left join vessel_latest_state vls on vls.mmsi = v.mmsi
        where v.mmsi = $1
        limit 1
        `,
        [q]
      );

      if (rs.rowCount === 0) {
        rs = await pool.query(
          `
          select
            mmsi,
            null::varchar as imo,
            '未知船舶' as name,
            '--' as type,
            '--' as flag,
            coalesce(nav_status, '未开始跟踪') as status,
            speed_knots as speed,
            heading,
            coalesce(destination, '--') as destination,
            eta_utc as eta,
            lat,
            lng,
            position_ts as "lastUpdate"
          from vessel_latest_state
          where mmsi = $1
          limit 1
          `,
          [q]
        );
      }
    } else if (isImo(q)) {
      rs = await pool.query(
        `
        select
          v.mmsi,
          v.imo,
          coalesce(v.vessel_name, '未知船舶') as name,
          coalesce(v.ship_type, '--') as type,
          coalesce(v.flag_country, '--') as flag,
          coalesce(vls.nav_status, '未开始跟踪') as status,
          vls.speed_knots as speed,
          vls.heading,
          coalesce(vls.destination, '--') as destination,
          vls.eta_utc as eta,
          coalesce(vls.lat, 0) as lat,
          coalesce(vls.lng, 0) as lng,
          vls.position_ts as "lastUpdate"
        from vessels v
        left join vessel_latest_state vls on vls.mmsi = v.mmsi
        where v.imo = $1
        limit 1
        `,
        [q]
      );
    } else {
      rs = await pool.query(
        `
        select
          v.mmsi,
          v.imo,
          coalesce(v.vessel_name, '未知船舶') as name,
          coalesce(v.ship_type, '--') as type,
          coalesce(v.flag_country, '--') as flag,
          coalesce(vls.nav_status, '未开始跟踪') as status,
          vls.speed_knots as speed,
          vls.heading,
          coalesce(vls.destination, '--') as destination,
          vls.eta_utc as eta,
          coalesce(vls.lat, 0) as lat,
          coalesce(vls.lng, 0) as lng,
          vls.position_ts as "lastUpdate"
        from vessels v
        left join vessel_latest_state vls on vls.mmsi = v.mmsi
        where v.vessel_name ilike $1
        order by v.updated_at desc nulls last, v.id desc
        limit 1
        `,
        [`%${q}%`]
      );
    }

    if (!rs || rs.rowCount === 0) {
      return {
        ok: true,
        data: {
          mmsi: isMmsi(q) ? q : null,
          imo: isImo(q) ? q : null,
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

    const row = rs.rows[0];

    return {
      ok: true,
      data: {
        ...row,
        riskLevel: '低',
        riskReason: '',
      },
    };
  });

  app.get('/api/ships/:mmsi/latest', async (req) => {
    const { mmsi } = req.params as { mmsi: string };

    const rs = await pool.query(
      `select * from vessel_latest_state where mmsi = $1`,
      [mmsi]
    );

    return {
      ok: true,
      data: rs.rows[0] || null,
    };
  });

  app.get('/api/ships/:mmsi/history', async (req) => {
    const { mmsi } = req.params as { mmsi: string };
    const hours = Number((req.query as any).hours || 24);

    const rs = await pool.query(
      `
      select *
      from vessel_position_history
      where mmsi = $1
        and position_ts >= now() - ($2 || ' hours')::interval
      order by position_ts desc
      `,
      [mmsi, hours]
    );

    return {
      ok: true,
      data: rs.rows,
    };
  });
}