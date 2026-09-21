// Browser-side stand-in for Google (GIS login + Drive REST) used by tests/e2e.py.
(() => {
  class MockDrive {
    constructor() { this.files = new Map(); this.seq = 1; }
    add(o) { const id = `f${this.seq++}`; const f = { id, trashed: false, modifiedTime: new Date().toISOString(), ...o }; this.files.set(id, f); return f; }
    async fetch(url, opts = {}) {
      const u = new URL(url); const method = opts.method || 'GET';
      const hdr = (k) => (opts.headers || {})[k];
      const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });
      if (u.host === 'upload.test') { const f = this.files.get(u.searchParams.get('id')); f.blob = opts.body; f.size = String(opts.body.size); return json({ id: f.id, name: f.name, size: f.size, modifiedTime: f.modifiedTime }); }
      if (!String(hdr('Authorization')).startsWith('Bearer ')) return json({ error: { message: 'no auth' } }, 401);
      if (u.pathname.startsWith('/upload/drive/v3/files')) {
        if (u.searchParams.get('uploadType') === 'resumable') {
          const meta = JSON.parse(opts.body); const id = method === 'PATCH' ? u.pathname.split('/').pop() : this.add({ name: meta.name, parents: meta.parents, mimeType: 'application/octet-stream' }).id;
          return new Response('{}', { status: 200, headers: { Location: `https://upload.test/session?id=${id}` } });
        }
        const buf = new Uint8Array(await new Response(opts.body).arrayBuffer());
        const text = new TextDecoder('latin1').decode(buf); const b = /boundary=(.+)$/.exec(hdr('Content-Type'))[1];
        const first = text.indexOf(`--${b}`); const mStart = text.indexOf('\r\n\r\n', first) + 4; const mEnd = text.indexOf(`\r\n--${b}`, mStart);
        const meta = JSON.parse(text.slice(mStart, mEnd));
        const cStart = text.indexOf('\r\n\r\n', mEnd) + 4; const cEnd = text.lastIndexOf(`\r\n--${b}--`);
        const content = buf.slice(cStart, cEnd);
        let f; if (method === 'PATCH') { f = this.files.get(u.pathname.split('/').pop()); f.name = meta.name; f.modifiedTime = new Date().toISOString(); } else f = this.add({ name: meta.name, parents: meta.parents, mimeType: 'application/octet-stream' });
        f.blob = new Blob([content]); f.size = String(content.length);
        return json({ id: f.id, name: f.name, size: f.size, modifiedTime: f.modifiedTime, webViewLink: `https://drive.google.com/file/d/${f.id}/view` });
      }
      if (u.pathname === '/drive/v3/files' && method === 'GET') {
        const qs = u.searchParams.get('q'); let out = [...this.files.values()].filter(f => !f.trashed);
        const nm = /name='((?:[^'\\]|\\.)*)'/.exec(qs); if (nm) out = out.filter(f => f.name === nm[1].replace(/\\'/g, "'"));
        if (/mimeType='application\/vnd.google-apps.folder'/.test(qs)) out = out.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
        const par = /'([^']+)' in parents/.exec(qs); if (par) out = out.filter(f => (f.parents || []).includes(par[1]));
        return json({ files: out.map(f => ({ id: f.id, name: f.name, size: f.size, modifiedTime: f.modifiedTime, mimeType: f.mimeType, webViewLink: `https://drive.google.com/file/d/${f.id}/view` })) });
      }
      if (u.pathname === '/drive/v3/files' && method === 'POST') { const b = JSON.parse(opts.body); return json({ id: this.add(b).id, name: b.name }); }
      const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
      if (m) {
        const f = this.files.get(m[1]); if (!f) return json({ error: { message: 'not found' } }, 404);
        if (method === 'DELETE') { this.files.delete(m[1]); return new Response(null, { status: 204 }); }
        if (u.searchParams.get('alt') === 'media') return new Response(f.blob, { status: 200 });
        return json({ id: f.id, trashed: f.trashed });
      }
      if (u.pathname === '/drive/v3/about') return json({ user: { displayName: 'Uji Coba', emailAddress: 'uji@example.com' } });
      return json({ error: { message: 'unhandled' } }, 500);
    }
  }
  const mock = new MockDrive(); window.__mockDrive = mock;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/^https:\/\/(www\.googleapis\.com|upload\.test)\//.test(url)) return mock.fetch(url, init || {});
    return realFetch(input, init);
  };
  window.google = { accounts: { oauth2: {
    initTokenClient(cfg) { return { callback() {}, error_callback() {}, requestAccessToken() { window.__gisPrompted = (window.__gisPrompted || 0) + 1; setTimeout(() => this.callback({ access_token: 'tok', expires_in: 3600 }), 20); } }; },
    revoke() {},
  } } };
})();
