import { FastifyInstance } from 'fastify';
import { pool } from '../../db/pg';
import { AisStreamClient } from '../stream/aisstream.client';

function isValidMmsi(mmsi: string) {
  return /^\d{9}$/.test(mmsi);
}

function isValidImo(imo: string) {
  return /^\d{7}$/.test(imo);
}

async function resolveMmsiFromInput(input: { mmsi?: string; imo?: string }) {
  const rawMmsi = String(input.mmsi || '').trim();
  const rawImo = String(input.imo || '').trim();

  if (rawMmsi) {
    if (!isValidMmsi(rawMmsi)) {
      throw new Error('mmsi 必须为 9 位数字');
    }
    return { mmsi: rawMmsi, imo: null };
  }

  if (rawImo) {
    if (!isValidImo(rawImo)) {
      throw new Error('imo 必须为 7 位数字');
    }

    const rs = await pool.query(
      `
      select mmsi, imo
      from vessels
      where imo = $1
      limit 1
      `,
      [rawImo]
    );

    if (rs.rowCount === 0) {
      throw new Error('未找到该 IMO 对应的船舶记录');
    }

    const mmsi = String(rs.rows[0].mmsi || '').trim();
    const imo = String(rs.rows[0].imo || '').trim();

    if (!isValidMmsi(mmsi)) {
      throw new Error('该 IMO 对应的 MMSI 无效，无法发起 AIS 跟踪');
    }

    return { mmsi, imo };
  }

  throw new Error('mmsi 或 imo 必填其一');
}

export async function registerTrackingRoutes(
  app: FastifyInstance,
  aisClient: AisStreamClient
) {
  app.post('/api/tracking/start', async (req, reply) => {
    try {
      const body = req.body as {
        mmsi?: string;
        imo?: string;
        watchReason?: string;
      };

      const { mmsi, imo } = await resolveMmsiFromInput(body);

      await pool.query(
        `
        insert into active_watchlist (mmsi, imo, watch_reason, status, updated_at)
        values ($1, $2, $3, 'active', now())
        on conflict (mmsi, status)
        do update set
          imo = excluded.imo,
          watch_reason = excluded.watch_reason,
          updated_at = now()
        `,
        [mmsi, imo, body.watchReason || 'manual start']
      );

      await aisClient.reloadTrackedMmsi();

      return {
        ok: true,
        data: {
          mmsi,
          imo,
          tracking: true,
        },
      };
    } catch (err: any) {
      return reply.code(400).send({
        ok: false,
        message: err?.message || '启动跟踪失败',
      });
    }
  });

  app.post('/api/tracking/stop', async (req, reply) => {
    try {
      const body = req.body as {
        mmsi?: string;
        imo?: string;
      };

      const { mmsi, imo } = await resolveMmsiFromInput(body);

      await pool.query(
        `
        update active_watchlist
        set status = 'stopped', updated_at = now()
        where mmsi = $1 and status = 'active'
        `,
        [mmsi]
      );

      await aisClient.reloadTrackedMmsi();

      return {
        ok: true,
        data: {
          mmsi,
          imo,
          tracking: false,
        },
      };
    } catch (err: any) {
      return reply.code(400).send({
        ok: false,
        message: err?.message || '停止跟踪失败',
      });
    }
  });
}