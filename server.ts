import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = (process.env.FLORA_API_URL || 'https://app.flora.ai/api/v1').replace(/\/$/, '');
const KEY = process.env.FLORA_API_KEY || '';
const WS = process.env.FLORA_WORKSPACE_ID || '';
const PORT = Number(process.env.PORT) || 3000;
const PROJECT_NAME = 'AICHAT';
let projectId: string | null = process.env.FLORA_PROJECT_ID || null;

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

function inferMime(name: string, rawType?: string): string {
  const clean = (rawType || '').split(';')[0].trim().toLowerCase();
  if (clean && clean !== 'application/octet-stream') return clean;
  const ext = path.extname(name || '').toLowerCase();
  return EXT_MIME[ext] || clean || 'application/octet-stream';
}

function safeDecodeName(raw?: string | string[]): string {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return 'file';
  try {
    return decodeURIComponent(s).replace(/[/\\]/g, '_') || 'file';
  } catch {
    return s.replace(/[/\\]/g, '_') || 'file';
  }
}

class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status = 500, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function assertConfigured() {
  if (!KEY || !WS) {
    throw new ApiError('FLORA_API_KEY dan FLORA_WORKSPACE_ID belum dikonfigurasi di server (.env).', 503);
  }
}

async function callApi(method: string, route: string, body?: unknown) {
  assertConfigured();
  const res = await fetch(API + route, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text || `API error ${res.status}` } };
  }
  if (!res.ok) {
    throw new ApiError(data?.error?.message || `API error ${res.status}`, res.status, data);
  }
  return data;
}

async function ensureProject(): Promise<string> {
  if (projectId) return projectId;
  try {
    const list = await callApi('GET', `/projects?workspace_id=${encodeURIComponent(WS)}&limit=50`);
    const items = list.projects || list.data || list.items || [];
    const found = items.find((p: any) => p.name === PROJECT_NAME) || null;
    if (found) {
      projectId = found.project_id;
      return found.project_id;
    }
  } catch (e: any) {
    console.warn('List projects gagal:', e.message);
  }
  const created = await callApi('POST', '/projects', { workspace_id: WS, name: PROJECT_NAME });
  projectId = created.project_id;
  return created.project_id;
}

async function startServer() {
  const app = express();

  app.get('/api/models', async (req, res) => {
    try {
      const qt = req.query.type;
      const t = qt === 'image' || qt === 'video' ? qt : 'text';
      res.status(200).json(await callApi('GET', `/models?type=${t}`));
    } catch (e: any) {
      res.status(e.status || 500).json(e.data || { error: { message: e.message } });
    }
  });

  app.post('/api/chat', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const { prompt, model, params, type: reqType } = req.body || {};
      const type = reqType === 'image' || reqType === 'video' ? reqType : 'text';
      if (!prompt) {
        return res.status(400).json({ error: { message: 'prompt wajib diisi' } });
      }
      const project_id = await ensureProject();
      const body: Record<string, unknown> = { workspace_id: WS, project_id, type, prompt };
      if (model) body.model = model;
      if (params && Object.keys(params).length) body.params = params;
      return res.status(200).json(await callApi('POST', '/generate', body));
    } catch (e: any) {
      return res.status(e.status || 500).json(e.data || { error: { message: e.message } });
    }
  });

  app.post('/api/upload', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
    try {
      const name = safeDecodeName(req.headers['x-file-name']);
      const type = inferMime(name, req.headers['content-type']);
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) {
        return res.status(400).json({ error: { message: 'File kosong atau gagal terbaca dari perangkat' } });
      }
      const a = await callApi('POST', '/assets', {
        source: 'signed-url',
        workspace_id: WS,
        file_name: name,
        content_type: type,
      });
      if (!a.upload?.url) {
        throw new ApiError('Server tidak mengembalikan URL upload', 502);
      }

      const method = (a.upload.method || 'POST').toUpperCase();
      let up: Response;
      if (method === 'PUT' && (!a.upload.form_fields || !Object.keys(a.upload.form_fields).length)) {
        up = await fetch(a.upload.url, {
          method: 'PUT',
          headers: {
            'Content-Type': type,
            ...(a.upload.headers || {}),
          },
          body: new Blob([new Uint8Array(buf)], { type }),
        });
      } else {
        const fd = new FormData();
        for (const [k, v] of Object.entries(a.upload.form_fields || {})) {
          fd.append(k, String(v));
        }
        fd.append(a.upload.file_field || 'file', new Blob([new Uint8Array(buf)], { type }), name);
        up = await fetch(a.upload.url, { method, body: fd });
      }

      if (!up.ok) {
        throw new ApiError(`Upload ke storage gagal (${up.status})`, 502);
      }
      const done = await callApi('POST', `/assets/${a.asset_id}/complete`);
      return res.status(200).json({
        asset_id: a.asset_id,
        url: done.url || a.url,
        status: done.status,
      });
    } catch (e: any) {
      if (e?.type === 'entity.too.large') {
        return res.status(413).json({ error: { message: 'File terlalu besar (maks 20 MB)' } });
      }
      return res.status(e.status || 500).json(e.data || { error: { message: e.message } });
    }
  });

  app.get('/api/runs/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!/^[\w-]+$/.test(id)) {
        return res.status(400).json({ error: { message: 'ID run tidak valid' } });
      }
      return res.status(200).json(await callApi('GET', `/runs/${id}`));
    } catch (e: any) {
      return res.status(e.status || 500).json(e.data || { error: { message: e.message } });
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { message: 'Not found' } });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', async (_req, res) => {
      const html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
      res.status(200).type('html').send(html);
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AiKoe berjalan di http://localhost:${PORT}`);
  });
}

startServer();
