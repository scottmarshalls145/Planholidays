const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const BOLDSIGN_BASE = 'https://api.boldsign.com';
const FALLBACK_KEY_B64 = 'MzUyZjcxNWUtMmNjYi00ODY1LTkxZmQtY2I5ZTUyMDk4NmRj';
function resolveBoldSignApiKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return decoded;
  } catch {}
  return raw;
}
const BOLDSIGN_API_KEY = resolveBoldSignApiKey(process.env.BOLDSIGN_API_KEY || FALLBACK_KEY_B64);
const MAX_BODY = 35 * 1024 * 1024;

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Accept'
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('Uploaded file is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid request JSON.')); }
    });
    req.on('error', reject);
  });
}

function addBoldSignFields(fd, payload) {
  fd.append('Title', payload.title || `Signature request — ${payload.fileName || 'Document'}`);
  fd.append('Message', payload.message || 'Please review and sign this document.');
  if (payload.senderName) fd.append('SenderDetail.Name', payload.senderName);
  if (payload.senderEmail) fd.append('SenderDetail.EmailAddress', payload.senderEmail);
  fd.append('Signers[0][Name]', payload.signerName || 'Signer');
  fd.append('Signers[0][EmailAddress]', payload.signerEmail);
  fd.append('Signers[0][SignerType]', 'Signer');
  fd.append('Signers[0][SignerOrder]', '1');
  fd.append('Signers[0][FormFields][0][FieldType]', 'Signature');
  fd.append('Signers[0][FormFields][0][PageNumber]', '1');
  fd.append('Signers[0][FormFields][0][Bounds][X]', '380');
  fd.append('Signers[0][FormFields][0][Bounds][Y]', '700');
  fd.append('Signers[0][FormFields][0][Bounds][Width]', '150');
  fd.append('Signers[0][FormFields][0][Bounds][Height]', '40');
  fd.append('Signers[0][FormFields][0][IsRequired]', 'true');
  fd.append('EnableSigningOrder', 'false');
  fd.append('DisableEmails', 'false');

  const seen = new Set();
  const cc = Array.isArray(payload.ccEmails) ? payload.ccEmails.slice() : [];
  if (payload.senderEmail) cc.push(payload.senderEmail);
  cc.filter(Boolean).forEach((email) => {
    const key = String(email).trim().toLowerCase();
    if (!key || key === String(payload.signerEmail || '').trim().toLowerCase() || seen.has(key)) return;
    seen.add(key);
    fd.append(`CC[${seen.size - 1}][EmailAddress]`, email);
  });
}

async function handleSend(req, res) {
  try {
    const payload = await readJson(req);
    if (!BOLDSIGN_API_KEY) return send(res, 500, { message: 'BoldSign API key is not configured.' });
    if (!payload.signerEmail) return send(res, 400, { message: 'Customer email is required.' });
    if (!payload.fileBase64) return send(res, 400, { message: 'Invoice document is required.' });

    const buffer = Buffer.from(payload.fileBase64, 'base64');
    const fd = new FormData();
    fd.append('Files', new Blob([buffer], { type: payload.fileType || 'application/pdf' }), payload.fileName || 'document.pdf');
    addBoldSignFields(fd, payload);

    const endpoints = [
      `${BOLDSIGN_BASE}/v1/document/send`,
      `${BOLDSIGN_BASE}/v1/document/senddocument`,
      `${BOLDSIGN_BASE}/v1/document/send-document`
    ];
    let last = null;
    for (const endpoint of endpoints) {
      const attemptFd = new FormData();
      attemptFd.append('Files', new Blob([buffer], { type: payload.fileType || 'application/pdf' }), payload.fileName || 'document.pdf');
      addBoldSignFields(attemptFd, payload);
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { 'X-API-KEY': BOLDSIGN_API_KEY, 'accept': 'application/json' },
        body: attemptFd
      });
      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      last = { status: upstream.status, data, endpoint };
      if (upstream.ok) return send(res, upstream.status, data);
      if (upstream.status !== 404 && upstream.status !== 405) break;
    }
    const message = (last && last.data && (last.data.message || last.data.error || last.data.raw)) || `BoldSign rejected the send request with status ${last ? last.status : 500}.`;
    send(res, last ? last.status : 500, { message, endpoint: last && last.endpoint, details: last && last.data });
  } catch (err) {
    send(res, 500, { message: err.message || 'BoldSign sender failed.' });
  }
}

async function handleProperties(url, res) {
  try {
    const documentId = url.searchParams.get('documentId');
    if (!documentId) return send(res, 400, { message: 'documentId is required.' });
    const upstream = await fetch(`${BOLDSIGN_BASE}/v1/document/properties?documentId=${encodeURIComponent(documentId)}`, {
      method: 'GET',
      headers: { 'X-API-KEY': BOLDSIGN_API_KEY, 'accept': 'application/json' }
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    send(res, upstream.status, data);
  } catch (err) {
    send(res, 500, { message: err.message || 'BoldSign status service failed.' });
  }
}

function serveStatic(req, res, pathname) {
  const clean = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, clean));
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
    send(res, 200, data, types[ext] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'POST' && url.pathname === '/api/boldsign/send') return handleSend(req, res);
  if (req.method === 'GET' && url.pathname === '/api/boldsign/properties') return handleProperties(url, res);
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
