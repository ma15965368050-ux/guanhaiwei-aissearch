import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export class ShipBroadcaster {
  private wss: WebSocketServer;
  private clients = new Map<string, Set<WebSocket>>();

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (socket, req) => {
      const url = new URL(req.url || '', 'http://localhost');
      const mmsi = url.searchParams.get('mmsi');

      if (!mmsi) {
        socket.close();
        return;
      }

      if (!this.clients.has(mmsi)) {
        this.clients.set(mmsi, new Set());
      }

      this.clients.get(mmsi)!.add(socket);

      socket.on('close', () => {
        const set = this.clients.get(mmsi);
        if (!set) return;
        set.delete(socket);
        if (set.size === 0) {
          this.clients.delete(mmsi);
        }
      });
    });
  }

  publish(mmsi: string, payload: unknown) {
    const set = this.clients.get(mmsi);
    if (!set) return;

    const text = JSON.stringify(payload);

    for (const client of set) {
      if (client.readyState === client.OPEN) {
        client.send(text);
      }
    }
  }
}