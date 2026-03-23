import WebSocket from 'ws';
import { pool } from '../../db/pg';
import { env } from '../../config/env';
import { ShipBroadcaster } from './broadcaster';

type ParsedPosition = {
  mmsi: string;
  lat: number;
  lng: number;
  speed_knots: number | null;
  course: number | null;
  heading: number | null;
  nav_status: string | null;
  destination: string | null;
  eta_utc: string | null;
  position_ts: string;
  raw_message: any;
};

export class AisStreamClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private trackedMmsi = new Set<string>();
  private isConnecting = false;

  constructor(private broadcaster: ShipBroadcaster) {}

  async start() {
    console.log('[AIS] start() called');
    await this.reloadTrackedMmsi();

    if (this.trackedMmsi.size > 0) {
      console.log('[AIS] start(): active watchlist exists, ensuring connection');
      this.connect();
    } else {
      console.log('[AIS] no active watchlist on startup, waiting for tracking command');
    }
  }

  async reloadTrackedMmsi() {
    console.log('[AIS] reloadTrackedMmsi called');

    const rs = await pool.query(
      `select mmsi from active_watchlist where status = 'active'`
    );

    const list = rs.rows.map((r: { mmsi: string | number }) => String(r.mmsi));
    this.trackedMmsi = new Set(list);

    console.log('[AIS] active tracked MMSI =', list);

    await this.safeLog('info', 'reload_tracked_mmsi', null, 'reloaded tracked MMSI list', {
      trackedMmsi: list,
      count: list.length,
    });

    if (this.trackedMmsi.size === 0) {
      console.log('[AIS] no active MMSI in watchlist');
      return;
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      console.log('[AIS] ws missing or closed, reconnecting...');
      this.connect();
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      console.log('[AIS] ws already open, resubscribing now');
      this.sendSubscribe();
      return;
    }

    console.log('[AIS] ws exists but not open yet, state =', this.ws.readyState);
  }

  private connect() {
    if (this.isConnecting) {
      console.log('[AIS] connect() skipped: already connecting');
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('[AIS] connect() skipped: ws already open');
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      console.log('[AIS] connect() skipped: ws already connecting');
      return;
    }

    this.isConnecting = true;
    console.log('[AIS] connecting to upstream...');

    this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    this.ws.on('open', async () => {
      this.isConnecting = false;
      console.log('[AIS] ws connected');

      await this.safeLog('info', 'ws_open', null, 'websocket connected', {
        trackedMmsiCount: this.trackedMmsi.size,
      });

      this.sendSubscribe();
    });

    this.ws.on('message', async (data) => {
      const text = data.toString();

      try {
        console.log('[AIS] raw message received =', text.slice(0, 500));

        const json = JSON.parse(text);
        const parsed = this.parseMessage(json);

        if (!parsed) {
          console.log('[AIS] message received but not a supported position report');

          await this.safeLog('info', 'message_ignored', null, 'unsupported or non-position message', {
            preview: text.slice(0, 500),
          });
          return;
        }

        console.log('[AIS] parsed position =', {
          mmsi: parsed.mmsi,
          lat: parsed.lat,
          lng: parsed.lng,
          speed_knots: parsed.speed_knots,
          heading: parsed.heading,
          position_ts: parsed.position_ts,
        });

        await this.safeLog('info', 'message_parsed', parsed.mmsi, 'parsed AIS position message', {
          lat: parsed.lat,
          lng: parsed.lng,
          speed_knots: parsed.speed_knots,
          heading: parsed.heading,
          position_ts: parsed.position_ts,
        });

        await this.upsertLatestState(parsed);
        await this.insertHistory(parsed);

        this.broadcaster.publish(parsed.mmsi, {
          type: 'position_update',
          data: {
            mmsi: parsed.mmsi,
            lat: parsed.lat,
            lng: parsed.lng,
            speed: parsed.speed_knots,
            heading: parsed.heading,
            status: parsed.nav_status,
            destination: parsed.destination,
            eta: parsed.eta_utc,
            lastUpdate: parsed.position_ts,
          },
        });
      } catch (error: any) {
        console.error('[AIS] parse/write error:', error);

        await this.safeLog('error', 'message_process_error', null, error?.message || 'parse/write error', {
          raw: text.slice(0, 1000),
        });
      }
    });

    this.ws.on('close', async (code, reason) => {
      this.isConnecting = false;
      const reasonText = reason?.toString?.() || '';

      console.log('[AIS] ws closed, code =', code, 'reason =', reasonText);

      await this.safeLog('error', 'ws_close', null, 'websocket closed', {
        code,
        reason: reasonText,
      });

      this.scheduleReconnect();
    });

    this.ws.on('error', async (error: any) => {
      this.isConnecting = false;
      console.error('[AIS] ws error:', error);

      await this.safeLog('error', 'ws_error', null, error?.message || 'websocket error', {
        stack: error?.stack || null,
      });

      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      console.log('[AIS] reconnect already scheduled');
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.trackedMmsi.size === 0) {
        console.log('[AIS] skip reconnect because no tracked MMSI');
        return;
      }

      console.log('[AIS] reconnecting now...');
      this.connect();
    }, 5000);
  }

  private sendSubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[AIS] subscribe skipped: ws not open');
      return;
    }

    if (this.trackedMmsi.size === 0) {
      console.log('[AIS] no tracked MMSI, skip subscribe');
      return;
    }

    const payload = {
      APIKey: env.AISSTREAM_API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FiltersShipMMSI: [...this.trackedMmsi],
      FilterMessageTypes: [
        'PositionReport',
        'StandardClassBPositionReport',
        'ExtendedClassBPositionReport',
      ],
    };

    console.log('[AIS] api key exists =', Boolean(env.AISSTREAM_API_KEY));
    console.log('[AIS] subscribing MMSI list =', payload.FiltersShipMMSI);
    console.log('[AIS] subscription payload preview =', {
      BoundingBoxes: payload.BoundingBoxes,
      FiltersShipMMSI: payload.FiltersShipMMSI,
      FilterMessageTypes: payload.FilterMessageTypes,
    });

    this.ws.send(JSON.stringify(payload));
    console.log('[AIS] subscription sent, count =', this.trackedMmsi.size);

    void this.safeLog('info', 'subscribe_sent', null, 'subscription sent to AIS upstream', {
      trackedMmsi: payload.FiltersShipMMSI,
      count: payload.FiltersShipMMSI.length,
      hasApiKey: Boolean(env.AISSTREAM_API_KEY),
    });
  }

  private parseMessage(msg: any): ParsedPosition | null {
    const report =
      msg?.Message?.PositionReport ||
      msg?.Message?.StandardClassBPositionReport ||
      msg?.Message?.ExtendedClassBPositionReport;

    if (!report) return null;

    const meta = msg?.MetaData || {};
    const mmsi = String(meta.MMSI || report.UserID || '').trim();

    if (!mmsi) return null;

    const lat = Number(report.Latitude);
    const lng = Number(report.Longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      mmsi,
      lat,
      lng,
      speed_knots: report.Sog != null ? Number(report.Sog) : null,
      course: report.Cog != null ? Number(report.Cog) : null,
      heading: report.TrueHeading != null ? Number(report.TrueHeading) : null,
      nav_status:
        report.NavigationalStatus != null
          ? String(report.NavigationalStatus)
          : null,
      destination: meta?.ShipName ? String(meta.ShipName) : null,
      eta_utc: null,
      position_ts: meta?.time_utc || new Date().toISOString(),
      raw_message: msg,
    };
  }

  private async upsertLatestState(p: ParsedPosition) {
    console.log('[AIS][DB] upsert latest_state start =', p.mmsi);

    await pool.query(
      `
      insert into vessel_latest_state (
        mmsi, lat, lng, speed_knots, course, heading,
        nav_status, destination, eta_utc, position_ts, source, raw_message, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, 'aisstream', $11, now()
      )
      on conflict (mmsi)
      do update set
        lat = excluded.lat,
        lng = excluded.lng,
        speed_knots = excluded.speed_knots,
        course = excluded.course,
        heading = excluded.heading,
        nav_status = excluded.nav_status,
        destination = excluded.destination,
        eta_utc = excluded.eta_utc,
        position_ts = excluded.position_ts,
        raw_message = excluded.raw_message,
        updated_at = now()
      `,
      [
        p.mmsi,
        p.lat,
        p.lng,
        p.speed_knots,
        p.course,
        p.heading,
        p.nav_status,
        p.destination,
        p.eta_utc,
        p.position_ts,
        p.raw_message,
      ]
    );

    console.log('[AIS][DB] upsert latest_state done =', p.mmsi);

    await this.safeLog('info', 'latest_state_upserted', p.mmsi, 'latest state upsert success', {
      lat: p.lat,
      lng: p.lng,
      position_ts: p.position_ts,
    });
  }

  private async insertHistory(p: ParsedPosition) {
    console.log('[AIS][DB] insert history start =', p.mmsi);

    await pool.query(
      `
      insert into vessel_position_history (
        mmsi, lat, lng, speed_knots, course, heading,
        nav_status, destination, eta_utc, position_ts, source, raw_message
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, 'aisstream', $11
      )
      `,
      [
        p.mmsi,
        p.lat,
        p.lng,
        p.speed_knots,
        p.course,
        p.heading,
        p.nav_status,
        p.destination,
        p.eta_utc,
        p.position_ts,
        p.raw_message,
      ]
    );

    console.log('[AIS][DB] insert history done =', p.mmsi);

    await this.safeLog('info', 'history_inserted', p.mmsi, 'position history inserted', {
      lat: p.lat,
      lng: p.lng,
      position_ts: p.position_ts,
    });
  }

  private async safeLog(
    level: string,
    eventType: string,
    mmsi: string | null,
    message: string,
    payload: any = null
  ) {
    try {
      await pool.query(
        `
        insert into ais_ingest_log (level, event_type, mmsi, message, payload)
        values ($1, $2, $3, $4, $5)
        `,
        [level, eventType, mmsi, message, payload]
      );
    } catch (err) {
      console.error('[AIS][LOG] failed to write ais_ingest_log:', err);
    }
  }
}