"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AisStreamClient = void 0;
const ws_1 = __importDefault(require("ws"));
const pg_1 = require("../../db/pg");
const env_1 = require("../../config/env");
class AisStreamClient {
    constructor(broadcaster) {
        this.broadcaster = broadcaster;
        this.ws = null;
        this.reconnectTimer = null;
        this.trackedMmsi = new Set();
    }
    async start() {
        await this.reloadTrackedMmsi();
        if (this.trackedMmsi.size > 0) {
            this.connect();
        }
        else {
            console.log('[AIS] no active watchlist on startup, waiting for tracking command');
        }
    }
    async reloadTrackedMmsi() {
        const rs = await pg_1.pool.query(`select mmsi from active_watchlist where status = 'active'`);
        this.trackedMmsi = new Set(rs.rows.map((r) => String(r.mmsi)));
        if (this.trackedMmsi.size === 0) {
            console.log('[AIS] no active MMSI in watchlist');
            return;
        }
        if (!this.ws || this.ws.readyState === ws_1.default.CLOSED) {
            this.connect();
            return;
        }
        if (this.ws.readyState === ws_1.default.OPEN) {
            this.sendSubscribe();
        }
    }
    connect() {
        this.ws = new ws_1.default('wss://stream.aisstream.io/v0/stream');
        this.ws.on('open', () => {
            console.log('[AIS] connected');
            this.sendSubscribe();
        });
        this.ws.on('message', async (data) => {
            try {
                const text = data.toString();
                const json = JSON.parse(text);
                const parsed = this.parseMessage(json);
                if (!parsed)
                    return;
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
            }
            catch (error) {
                console.error('[AIS] parse error:', error);
            }
        });
        this.ws.on('close', () => {
            console.log('[AIS] closed');
            this.scheduleReconnect();
        });
        this.ws.on('error', (error) => {
            console.error('[AIS] error:', error);
            this.scheduleReconnect();
        });
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.trackedMmsi.size === 0) {
                console.log('[AIS] skip reconnect because no tracked MMSI');
                return;
            }
            this.connect();
        }, 5000);
    }
    sendSubscribe() {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN)
            return;
        if (this.trackedMmsi.size === 0) {
            console.log('[AIS] no tracked MMSI, skip subscribe');
            return;
        }
        const payload = {
            APIKey: env_1.env.AISSTREAM_API_KEY,
            BoundingBoxes: [[[-90, -180], [90, 180]]],
            FiltersShipMMSI: [...this.trackedMmsi],
            FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
        };
        this.ws.send(JSON.stringify(payload));
        console.log('[AIS] subscribed MMSI count:', this.trackedMmsi.size);
    }
    parseMessage(msg) {
        const report = msg?.Message?.PositionReport ||
            msg?.Message?.StandardClassBPositionReport ||
            msg?.Message?.ExtendedClassBPositionReport;
        if (!report)
            return null;
        const meta = msg?.MetaData || {};
        const mmsi = String(meta.MMSI || report.UserID || '');
        if (!mmsi)
            return null;
        const lat = Number(report.Latitude);
        const lng = Number(report.Longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng))
            return null;
        return {
            mmsi,
            lat,
            lng,
            speed_knots: report.Sog != null ? Number(report.Sog) : null,
            course: report.Cog != null ? Number(report.Cog) : null,
            heading: report.TrueHeading != null ? Number(report.TrueHeading) : null,
            nav_status: report.NavigationalStatus != null ? String(report.NavigationalStatus) : null,
            destination: meta?.ShipName ? String(meta.ShipName) : null,
            eta_utc: null,
            position_ts: meta?.time_utc || new Date().toISOString(),
            raw_message: msg,
        };
    }
    async upsertLatestState(p) {
        await pg_1.pool.query(`
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
      `, [
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
        ]);
    }
    async insertHistory(p) {
        await pg_1.pool.query(`
      insert into vessel_position_history (
        mmsi, lat, lng, speed_knots, course, heading,
        nav_status, destination, eta_utc, position_ts, source, raw_message
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, 'aisstream', $11
      )
      `, [
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
        ]);
    }
}
exports.AisStreamClient = AisStreamClient;
