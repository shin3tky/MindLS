/**
 * テスト用の最小 LSP クライアント。
 * サーバを本物のサブプロセスとして起動し、stdio で JSON-RPC を話す。
 * モックではなく実物を動かすので、配線の間違いもここで落ちる。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'dist', 'cli.js',
);

interface PendingResolver {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class LspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingResolver>();
  private readonly notifications: Array<{ method: string; params: unknown }> = [];
  private buffer = Buffer.alloc(0);
  private nextId = 1;

  /** @param server 起動する実体。既定は開発中の dist/cli.js（バンドルの検証では差し替える） */
  constructor(server: string = SERVER) {
    this.child = spawn(process.execPath, [server, '--stdio'], { stdio: 'pipe' });
    this.child.stdout.on('data', (chunk: Buffer) => { this.onData(chunk); });
    this.child.stderr.on('data', () => { /* サーバのログは無視 */ });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (match === null) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;

      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);

      const msg = JSON.parse(body) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (typeof msg.method === 'string') {
        this.notifications.push({ method: msg.method, params: msg.params });
      }
    }
  }

  private write(payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    this.child.stdin.write(`Content-Length: ${String(body.length)}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} が応答しませんでした`));
      }, 10_000);
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** 指定の通知が来るまで待つ */
  async waitForNotification(method: string, timeoutMs = 5_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.notifications.findIndex((n) => n.method === method);
      if (i >= 0) return this.notifications.splice(i, 1)[0]!.params;
      if (Date.now() > deadline) throw new Error(`${method} が届きませんでした`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** たまっている通知を捨てる（didOpen では publishDiagnostics が複数回来る） */
  drainNotifications(method: string): void {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      if (this.notifications[i]!.method === method) this.notifications.splice(i, 1);
    }
  }

  async initialize(initializationOptions?: unknown): Promise<unknown> {
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      initializationOptions,
    });
    this.notify('initialized', {});
    return result;
  }

  openDocument(uri: string, text: string): void {
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'mind', version: 1, text },
    });
  }

  async dispose(): Promise<void> {
    try {
      await this.request('shutdown', null);
      this.notify('exit', null);
    } catch {
      /* すでに落ちている */
    }
    this.child.kill();
  }
}
