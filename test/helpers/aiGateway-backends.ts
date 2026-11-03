import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request seen by a mock backend. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  raw: string;
  json: Record<string, unknown> | null;
}

/** A running mock backend on 127.0.0.1. */
export interface MockBackend {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Starts a node:http mock backend; `handler` replies to each recorded request. */
export function startBackend(
  handler: (req: RecordedRequest, res: ServerResponse) => void | Promise<void>,
): Promise<MockBackend> {
  const requests: RecordedRequest[] = [];
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(raw);
          json =
            typeof parsed === 'object' && parsed !== null
              ? (parsed as Record<string, unknown>)
              : null;
        } catch {
          json = null;
        }
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          raw,
          json,
        };
        requests.push(recorded);
        void Promise.resolve(handler(recorded, res)).catch(() => {
          res.destroy();
        });
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Writes a JSON reply. */
export function replyJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/** A chat-completions reply carrying `content`. */
export function chatReply(content: string, finishReason = 'stop'): object {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
  };
}
