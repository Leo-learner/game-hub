import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { backup, verifyBackup } from '../modules/backups.js';
import { fail } from '../errors.js';

const exec = promisify(execFile);
export type Control = (action: 'status' | 'logs' | 'restart', lines?: number, minutes?: number) => Promise<string>;
export const systemControl: Control = async (action, lines = 100, minutes = 60) => {
  const args = ['-n', '/usr/local/sbin/game-hub-control', action];
  if (action === 'logs') args.push(String(lines), String(minutes));
  try {
    const {stdout} = await exec('/usr/bin/sudo', args, {timeout: 25000, maxBuffer: 256 * 1024, env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
    return stdout.trim();
  } catch { fail(503, 'SERVICE_CONTROL_UNAVAILABLE', '网站运维助手不可用，请检查部署和服务状态'); }
};
export const backupIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export class Operations {
  private busy = false;
  constructor(private db: Db, private config: Config, public control: Control = systemControl) {}
  async exclusive<T>(fn: () => Promise<T>) {
    if (this.busy) fail(409, 'OPERATION_BUSY', '另一个备份、校验或重启操作正在进行，请稍后重试');
    this.busy = true;
    try {return await fn();} finally {this.busy = false;}
  }
  async apiHealthy() {
    try {return (await fetch(`http://127.0.0.1:${this.config.port}/readyz`, {signal: AbortSignal.timeout(3000)})).ok;}
    catch {return false;}
  }
  async status() {
    const count = (sql: string) => (this.db.prepare(sql).get() as {n: number}).n;
    const disk = await statfs(this.config.dataDir);
    let services: unknown;
    try {services = JSON.parse(await this.control('status'));} catch {services = {available: false};}
    return {
      website: {origin: this.config.publicOrigin, ready: await this.apiHealthy(), services},
      mcp: {uptimeSeconds: Math.floor(process.uptime()), memoryBytes: process.memoryUsage().rss},
      counts: {
        players: count("SELECT COUNT(*) AS n FROM users WHERE role='player'"),
        games: count('SELECT COUNT(*) AS n FROM games'), publishedGames: count('SELECT COUNT(*) AS n FROM games WHERE published=1'),
        releases: count('SELECT COUNT(*) AS n FROM game_releases'),
        activeSaveSlots: count('SELECT COUNT(*) AS n FROM saves WHERE deleted_at IS NULL'),
        saveBytes: count('SELECT COALESCE(SUM(size_bytes),0) AS n FROM saves WHERE deleted_at IS NULL'),
      },
      disk: {availableBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize},
      analyticsNote: '计数来自当前数据库，不代表访客数、游玩次数或活跃玩家。',
    };
  }
  async listBackups(limit: number) {
    const base = path.join(this.config.dataDir, 'backups');
    let names: string[];
    try {names = (await readdir(base, {withFileTypes: true})).filter(x => x.isDirectory() && backupIdPattern.test(x.name)).map(x => x.name).sort().reverse();}
    catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {items: [], total: 0}; throw e;}
    const items = await Promise.all(names.slice(0, limit).map(async id => {
      try {
        const m = JSON.parse(await readFile(path.join(base, id, 'manifest.json'), 'utf8'));
        return {id, complete: true, createdAt: m.createdAt, releaseCount: m.releaseCount};
      } catch {return {id, complete: false};}
    }));
    return {items, total: names.length, note: 'complete 仅表示存在清单，完整性需 verify_backup 校验。'};
  }
  async createBackup() {
    return this.exclusive(async () => ({id: path.basename(await backup(this.db, this.config)), verified: true, retentionDays: 7}));
  }
  async verify(id: string) {
    if (!backupIdPattern.test(id)) fail(400, 'INVALID_BACKUP_ID', '请选择 list_backups 返回的备份 ID');
    const base = await realpath(path.join(this.config.dataDir, 'backups'));
    let dir: string;
    try {dir = await realpath(path.join(base, id));} catch {fail(404, 'BACKUP_NOT_FOUND', '备份不存在');}
    if (path.dirname(dir) !== base) fail(400, 'INVALID_BACKUP_ID', '备份目录无效');
    return this.exclusive(async () => ({id, verified: true, manifest: await verifyBackup(dir)}));
  }
  async restart() {
    return this.exclusive(async () => {
      await this.control('restart');
      for (let i = 0; i < 20; i++) {
        if (await this.apiHealthy()) return {restarted: true, ready: true};
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      fail(503, 'WEBSITE_NOT_READY', '已请求重启，但网站尚未通过健康检查，请读取服务日志');
    });
  }
}
