import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth } from 'google-auth-library';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// --- ADMIN AUTH: Google login whitelist ---
const ALLOWED_EMAILS = (process.env.ADMIN_EMAILS || 'nadhasantika63@gmail.com,granadds@gmail.com,hellonadiaaane@gmail.com').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
function isAdminEmail(email){
  if(!email) return false;
  return ALLOWED_EMAILS.includes(String(email).toLowerCase());
}
function requireAdmin(req, res, next){
  const tokens = loadTokens();
  const email = tokens?.email || null;
  if(!tokens) return res.status(401).json({ error: 'Belum login Google. Buka /auth/login dulu.' });
  if(!email) return res.status(401).json({ error: 'Email tidak terdeteksi. Re-login Google.' });
  if(!isAdminEmail(email)) return res.status(403).json({ error: `Akses ditolak untuk ${email}. Hanya ${ALLOWED_EMAILS.join(', ')} yang boleh.` });
  return next();
}

// Simple env loader without dotenv dependency
const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  txt.split('\n').forEach(line=>{
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if(m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  });
}

// --- FIRESTORE (tanpa firebase-admin) ---
const pk = process.env.FIREBASE_PRIVATE_KEY?.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
const db = new Firestore({
  projectId: process.env.FIREBASE_PROJECT_ID,
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: pk,
  },
});
const projectsCol = db.collection('projects');
const shootsCol = db.collection('shoots');
const schedulesCol = db.collection('schedules');
const bookingsCol = db.collection('bookings');
const showcaseCol = db.collection('showcase');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const TOKEN_FILE = path.join(DATA_DIR, 'google_tokens.json');
function loadTokens(){ if(!fs.existsSync(TOKEN_FILE)) return null; try{ return JSON.parse(fs.readFileSync(TOKEN_FILE,'utf8')) }catch{ return null } }
function saveTokens(t){ fs.writeFileSync(TOKEN_FILE, JSON.stringify(t,null,2)) }

function getOAuthClient(){
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
  if(!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getDriveClient(){
  const tokens = loadTokens();
  if(!tokens) return null;
  const oauth2 = getOAuthClient();
  if(!oauth2) return null;
  oauth2.setCredentials(tokens);
  oauth2.on('tokens', (t)=>{ 
    const cur = loadTokens() || {};
    const merged = { ...cur, ...t };
    saveTokens(merged);
  });
  return google.drive({ version: 'v3', auth: oauth2 });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const projectId = req.params.id || req.body.projectId || 'temp';
    const dir = path.join(UPLOAD_DIR, projectId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2,7) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 100 },
  fileFilter: (req, file, cb) => {
    if(!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diperbolehkan'));
    cb(null, true);
  }
});

// showcase upload (separate dir)
const showcaseDir = path.join(UPLOAD_DIR, 'showcase');
if (!fs.existsSync(showcaseDir)) fs.mkdirSync(showcaseDir, { recursive: true });
const showcaseStorage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, showcaseDir); },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2,7) + ext);
  }
});
const showcaseUpload = multer({
  storage: showcaseStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if(!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diperbolehkan'));
    cb(null, true);
  }
});

function extractDriveFolderId(link) {
  if (!link) return null;
  const m1 = link.match(/\/folders\/([a-zA-Z0-9-_]+)/);
  if (m1) return m1[1];
  const m2 = link.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (m2) return m2[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(link.trim())) return link.trim();
  return null;
}

function selVal(v){ if(v==null) return 0; if(typeof v==='object') return v.v ?? v.value ?? 0; return Number(v)||0; }
function selNote(v){ if(typeof v==='object') return (v.note ?? v.comment ?? '').toString().slice(0,500); return ''; }

function getProjectPhotos(project) {
  const dir = path.join(UPLOAD_DIR, project.id);
  let files = [];
  if (fs.existsSync(dir)) {
    files = fs.readdirSync(dir)
      .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .map(f => ({ id: f, filename: f, url: `/uploads/${project.id}/${f}`, driveId: null, driveUrl: null }));
  }
  if (project.drivePhotos && project.drivePhotos.length > 0) return project.drivePhotos;
  return files;
}

// --- AUTH ---
app.get('/auth/status', (req,res)=>{
  const tokens = loadTokens();
  const oauth = getOAuthClient();
  const email = tokens?.email || null;
  res.json({
    configured: !!oauth,
    loggedIn: !!tokens,
    email,
    isAdmin: isAdminEmail(email),
    allowed: ALLOWED_EMAILS,
    hasApiKey: !!process.env.GOOGLE_API_KEY,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`
  });
});

app.get('/auth/login', (req,res)=>{
  const oauth2 = getOAuthClient();
  if(!oauth2) return res.status(400).send('GOOGLE_CLIENT_ID / SECRET belum di-set. Cek .env.example');
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/userinfo.email']
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req,res)=>{
  const code = req.query.code;
  if(!code) return res.status(400).send('Missing code');
  try{
    const oauth2 = getOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    let email = null;
    try{
      const oauth2api = google.oauth2({version:'v2', auth: oauth2});
      const me = await oauth2api.userinfo.get();
      email = me.data.email;
    }catch{}
    if(email && !isAdminEmail(email)){
      return res.status(403).send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Akses Ditolak</h2><p>Email ${email} tidak diizinkan.</p><p>Hanya ${ALLOWED_EMAILS.join(', ')} yang boleh login owner.</p><p><a href="/auth/logout">Logout</a> lalu login dengan akun yang benar.</p></body></html>`);
    }
    saveTokens({ ...tokens, email, obtainedAt: new Date().toISOString() });
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Granads Drive Connected</h2><p>Login sebagai ${email||'Google Account'} berhasil</p><p>Token tersimpan. Bisa tutup tab ini & kembali ke <a href="/owner.html">Owner Dashboard</a></p><script>setTimeout(()=>location.href='/owner.html', 2000)</script></body></html>`);
  }catch(e){
    res.status(500).send('OAuth error: '+e.message);
  }
});

app.post('/auth/logout', (req,res)=>{
  if(fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  res.json({ok:true});
});

// --- API ---
app.post('/api/projects', requireAdmin, async (req, res) => {
  let { clientName, driveLink, maxSelection, deadline } = req.body;
  if (!clientName || !String(clientName).trim()) return res.status(400).json({ error: 'Nama client wajib' });
  clientName = String(clientName).trim().slice(0,120).replace(/[<>]/g,'');
  const id = uuidv4().slice(0, 8);
  const folderId = extractDriveFolderId(driveLink);
  const project = {
    id, clientName, driveLink: driveLink || '', driveFolderId: folderId,
    maxSelection: parseInt(maxSelection) || 20,
    deadline: deadline || null,
    createdAt: new Date().toISOString(),
    selections: {}, drivePhotos: [], status: 'active',
    driveFolders: null
  };
  await projectsCol.doc(id).set(project);
  const host = req.get('host');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const baseUrl = host ? `${proto}://${host}` : `http://localhost:${PORT}`;
  res.json({ project, clientLink: `/client.html?id=${id}`, fullClientLink: `${baseUrl}/client.html?id=${id}` });
});

app.get('/api/projects', requireAdmin, async (req, res) => {
  const snap = await projectsCol.orderBy('createdAt', 'desc').get();
  const projects = snap.docs.map(d => d.data());
  const enriched = projects.map(p => {
    const photos = getProjectPhotos(p);
    const sel = p.selections || {};
    const counts = { selected: 0, considered: 0, rejected: 0, notes: 0 };
    Object.values(sel).forEach(v => { const val = selVal(v); if (val === 1) counts.selected++; else if (val === 2) counts.considered++; else if (val === 3) counts.rejected++; if(val===1 && selNote(v)) counts.notes++; });
    return { ...p, photoCount: photos.length || 0, counts };
  });
  res.json(enriched);
});

app.get('/api/projects/:id', async (req, res) => {
  const doc = await projectsCol.doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Project tidak ditemukan' });
  const p = doc.data();
  const photos = getProjectPhotos(p);
  res.json({ ...p, photos });
});

app.get('/api/folder/:folderId/photos', async (req, res) => {
  const { folderId } = req.params;
  if (!folderId) return res.status(400).json({ error: 'folderId wajib' });
  try {
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
    const tokens = loadTokens();
    let photos = [];
    if (tokens) {
      const oauth2 = getOAuthClient();
      oauth2.setCredentials(tokens);
      const drive = google.drive({ version: 'v3', auth: oauth2 });
      const r = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false and mimeType contains 'image/'`,
        fields: 'files(id,name,mimeType)', pageSize: 1000
      });
      photos = (r.data.files || []).map(f => ({
        id: f.id, name: f.name,
        url: `https://drive.google.com/thumbnail?id=${f.id}&sz=w800`
      }));
    } else if (GOOGLE_API_KEY) {
      let pageToken = null;
      let allFiles = [];
      do {
        let url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false+and+mimeType+contains+'image/'&fields=nextPageToken,files(id,name,mimeType)&key=${GOOGLE_API_KEY}&pageSize=1000`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const r = await fetch(url); const j = await r.json();
        if (j.error) return res.status(400).json({ error: j.error.message });
        allFiles = allFiles.concat(j.files || []);
        pageToken = j.nextPageToken;
      } while (pageToken);
      photos = allFiles.map(f => ({
        id: f.id, name: f.name,
        url: `https://drive.google.com/thumbnail?id=${f.id}&sz=w800`
      }));
    } else {
      return res.status(400).json({ error: 'Butuh GOOGLE_API_KEY atau OAuth login' });
    }
    res.json({ photos, count: photos.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:id/selections', async (req, res) => {
  let { selections } = req.body;
  // sanitasi: catatan hanya untuk yang Dipilih (v===1)
  if(selections && typeof selections==='object'){
    for(const [k, raw] of Object.entries(selections)){
      const v = selVal(raw); const n = selNote(raw);
      if(v!==1 && n){
        // strip note kalau bukan Dipilih
        selections[k]=v;
      }
      // normalisasi: jika v===1 dan ada note, simpan sebagai {v, note}
      if(v===1 && n) selections[k]={ v:1, note: n.slice(0,500) };
    }
  }
  const ref = projectsCol.doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Project tidak ditemukan' });
  await ref.update({ selections: selections || {}, updatedAt: new Date().toISOString() });
  res.json({ ok: true, selections: selections || {} });
});

app.post('/api/projects/:id/select', async (req, res) => {
  const { photoId, value, note } = req.body;
  const ref = projectsCol.doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Project tidak ditemukan' });
  const selections = doc.data().selections || {};
  if (value === null || value === 0) {
    delete selections[photoId];
  } else {
    const v = parseInt(value);
    const curNote = selNote(selections[photoId]);
    // catatan hanya untuk v===1
    if(v===1 && curNote) selections[photoId] = { v, note: curNote };
    else if(v===1 && typeof note==='string' && note.trim()) selections[photoId] = { v, note: note.trim().slice(0,500) };
    else selections[photoId] = v; // v===2/3 strip note
  }
  // allow note-only update -> hanya jika sudah Dipilih
  if((value===undefined) && typeof note==='string'){
    const curVal = selVal(selections[photoId]);
    if(curVal!==1) { /* ignore note untuk non-Dipilih */ }
    else if(!note.trim()) selections[photoId]=1;
    else selections[photoId] = { v: 1, note: note.trim().slice(0,500) };
  }
  await ref.update({ selections });
  res.json({ ok: true });
});

app.post('/api/projects/:id/upload', requireAdmin, upload.array('photos', 100), async (req, res) => {
  const doc = await projectsCol.doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Project tidak ditemukan' });
  res.json({ ok: true, uploaded: req.files.length });
});

// Fetch from Drive (API Key OR OAuth)
app.post('/api/projects/:id/fetch-drive', requireAdmin, async (req, res) => {
  const { driveLink } = req.body;
  const ref = projectsCol.doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'Project tidak ditemukan' });
  const project = doc.data();
  const folderId = extractDriveFolderId(driveLink || project.driveLink);
  if (!folderId) return res.status(400).json({ error: 'Link Drive tidak valid' });

  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
  const tokens = loadTokens();
  let photos = [];

  try {
    if (tokens) {
      const drive = getDriveClient();
      let pageToken = null;
      let allFiles = [];
      do {
        const r = await drive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'nextPageToken, files(id,name,mimeType,thumbnailLink)',
          pageSize: 1000,
          pageToken: pageToken || undefined
        });
        allFiles = allFiles.concat(r.data.files || []);
        pageToken = r.data.nextPageToken;
      } while (pageToken);
      photos = allFiles.filter(f=>f.mimeType.startsWith('image/')).map(f=>({
        id: f.id, filename: f.name, driveId: f.id,
        url: `https://drive.google.com/thumbnail?id=${f.id}&sz=w800`,
        driveUrl: `https://drive.google.com/uc?id=${f.id}`, thumbnail: f.thumbnailLink
      }));
    } else if (GOOGLE_API_KEY) {
      let pageToken = null;
      let allFiles = [];
      do {
        let url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=nextPageToken,files(id,name,mimeType,thumbnailLink)&key=${GOOGLE_API_KEY}&pageSize=1000`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const r = await fetch(url); const j = await r.json();
        if (j.error) return res.status(400).json({ error: j.error.message, hint: 'Pastikan folder public (Anyone with link)' });
        allFiles = allFiles.concat(j.files || []);
        pageToken = j.nextPageToken;
      } while (pageToken);
      photos = allFiles.filter(f => f.mimeType.startsWith('image/')).map(f => ({
        id: f.id, filename: f.name, driveId: f.id,
        url: `https://drive.google.com/thumbnail?id=${f.id}&sz=w800`,
        driveUrl: `https://drive.google.com/uc?id=${f.id}`, thumbnail: f.thumbnailLink
      }));
    } else {
      return res.json({ ok:false, message:'Butuh GOOGLE_API_KEY (public folder) ATAU login OAuth. Set di .env', folderId });
    }

    const updateData = { drivePhotos: photos, driveFolderId: folderId };
    if (driveLink) updateData.driveLink = driveLink;
    await ref.update(updateData);
    res.json({ ok:true, photos, count: photos.length, via: tokens ? 'oauth' : 'apiKey' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Create 2 subfolders in Drive & copy files based on selections (needs OAuth)
app.post('/api/projects/:id/create-drive-folders', requireAdmin, async (req,res)=>{
  const ref = projectsCol.doc(req.params.id);
  const doc = await ref.get();
  if(!doc.exists) return res.status(404).json({error:'Project tidak ditemukan'});
  const project = doc.data();
  const folderId = project.driveFolderId || extractDriveFolderId(project.driveLink);
  if(!folderId) return res.status(400).json({error:'Project belum ada Drive folderId. Paste link Drive dulu.'});
  const drive = getDriveClient();
  if(!drive) return res.status(400).json({error:'Belum login Google. Klik Login Google di Owner Dashboard dulu.'});

  const selections = project.selections || {};
  if(Object.keys(selections).length===0) return res.status(400).json({error:'Belum ada pilihan dari client.'});

  try{
    async function getOrCreate(name){
      const q = `'${folderId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const r = await drive.files.list({ q, fields:'files(id,name)' });
      if(r.data.files && r.data.files.length>0) return r.data.files[0].id;
      const created = await drive.files.create({
        requestBody: { name, mimeType:'application/vnd.google-apps.folder', parents:[folderId] },
        fields:'id'
      });
      return created.data.id;
    }
    const fidSelected = await getOrCreate('01 - Terpilih');
    const fidConsidered = await getOrCreate('02 - Dipertimbangkan');

    let copied = 0, uploaded = 0;
    for(const [photoId, raw] of Object.entries(selections)){
      const val = selVal(raw);
      if(val !== 1 && val !== 2) continue;
      let targetFolder = val===1 ? fidSelected : fidConsidered;
      const drivePhoto = (project.drivePhotos||[]).find(p=>p.id===photoId);
      if(drivePhoto && drivePhoto.driveId){
        try{
          await drive.files.copy({ fileId: drivePhoto.driveId, requestBody:{ parents:[targetFolder] } });
          copied++;
        }catch(e){ console.log('copy fail', photoId, e.message)}
      } else {
        const localPath = path.join(UPLOAD_DIR, project.id, photoId);
        if(fs.existsSync(localPath)){
          const media = { mimeType: 'image/jpeg', body: fs.createReadStream(localPath) };
          await drive.files.create({ requestBody:{ name: photoId, parents:[targetFolder] }, media, fields:'id' });
          uploaded++;
        }
      }
    }

    await ref.update({ driveFolders: { selected: fidSelected, considered: fidConsidered, updatedAt: new Date().toISOString() } });

    const base = `https://drive.google.com/drive/folders/${folderId}`;
    res.json({
      ok:true, copied, uploaded,
      folders:{
        'Terpilih': `https://drive.google.com/drive/folders/${fidSelected}`,
        'Dipertimbangkan': `https://drive.google.com/drive/folders/${fidConsidered}`,
        'Induk': base
      }
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

app.delete('/api/projects/:id', requireAdmin, async (req, res) => {
  await projectsCol.doc(req.params.id).delete();
  const dir = path.join(UPLOAD_DIR, req.params.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/health', (req,res)=> res.json({ ok:true, uptime: process.uptime(), ts: new Date().toISOString() }));

// --- PUBLIC API (no auth) ---
app.get('/api/public/schedules', async (req, res) => {
  const snap = await schedulesCol.orderBy('date', 'asc').get();
  const items = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  res.json(items);
});

// --- Domain routing: granads.k3unair.com → portfolio ---
app.get('/', (req, res) => {
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(':')[0];
  if(host === 'granads.k3unair.com'){
    return res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
  }
  res.redirect('/moodboard.html');
});

// --- SHOOTS API (Firestore) ---
app.get('/api/shoots', requireAdmin, async (req, res) => {
  const snap = await shootsCol.orderBy('createdAt', 'desc').get();
  const items = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  res.json(items);
});
app.post('/api/shoots', requireAdmin, async (req, res) => {
  const data = req.body;
  delete data.id;
  data.createdAt = new Date().toISOString();
  const ref = await shootsCol.add(data);
  await ref.set({ id: ref.id }, { merge: true });
  res.json({ ...data, id: ref.id });
});
app.put('/api/shoots/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  delete data.id;
  await shootsCol.doc(id).set(data, { merge: true });
  res.json({ ok: true, id });
});
app.delete('/api/shoots/:id', requireAdmin, async (req, res) => {
  await shootsCol.doc(req.params.id).delete();
  res.json({ ok: true });
});

// --- SCHEDULES API (Firestore) ---
app.get('/api/schedules', requireAdmin, async (req, res) => {
  const snap = await schedulesCol.orderBy('date', 'asc').get();
  const items = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  res.json(items);
});
app.post('/api/schedules', requireAdmin, async (req, res) => {
  const data = req.body;
  delete data.id;
  data.createdAt = new Date().toISOString();
  const ref = await schedulesCol.add(data);
  await ref.set({ id: ref.id }, { merge: true });
  res.json({ ...data, id: ref.id });
});
app.put('/api/schedules/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const data = req.body;
  delete data.id;
  await schedulesCol.doc(id).set(data, { merge: true });
  res.json({ ok: true, id });
});
app.delete('/api/schedules/:id', requireAdmin, async (req, res) => {
  await schedulesCol.doc(req.params.id).delete();
  res.json({ ok: true });
});

// --- BOOKINGS API (Firestore) ---
// Public: create booking
app.post('/api/bookings', async (req, res) => {
  let { name, wa, date, time, location, people, concept, needs, note } = req.body;
  if(!name || !String(name).trim()) return res.status(400).json({ error: 'Nama wajib' });
  if(!wa || !String(wa).trim()) return res.status(400).json({ error: 'No WA wajib' });
  if(!date) return res.status(400).json({ error: 'Tanggal wajib' });
  if(!time) return res.status(400).json({ error: 'Waktu wajib' });
  name = String(name).trim().slice(0,80);
  wa = String(wa).trim().slice(0,20);
  location = String(location||'').trim().slice(0,200);
  people = String(people||'').trim().slice(0,10);
  concept = String(concept||'').trim().slice(0,200);
  needs = String(needs||'').trim().slice(0,1000);
  note = String(note||'').trim().slice(0,1000);
  // minimal H+3 & blokir sebelum hari ini s/d H+2
  const minD = new Date(); minD.setHours(0,0,0,0); minD.setDate(minD.getDate()+3);
  const minStr = minD.toISOString().slice(0,10);
  if(String(date) < minStr) return res.status(400).json({ error: `Minimal booking H+3 (paling cepat ${minStr}).` });
  // check jam sudah booked (disable jam)
  const daySched = await schedulesCol.where('date','==',date).get();
  const bookedTimes = daySched.docs.map(d=> (d.data().time||'').slice(0,5));
  if(bookedTimes.includes(String(time).slice(0,5))){
    return res.status(400).json({ error: `Jam ${time} sudah booked. Pilih jam lain.` });
  }
  const data = { name, wa, date, time: String(time).slice(0,5), location, people, concept, needs, note, status:'pending', createdAt: new Date().toISOString() };
  const ref = await bookingsCol.add(data);
  res.json({ id: ref.id, ...data });
});
app.get('/api/bookings', requireAdmin, async (req, res) => {
  const snap = await bookingsCol.orderBy('createdAt','desc').get();
  const items = snap.docs.map(d=> ({ ...d.data(), id:d.id }));
  res.json(items);
});
app.get('/api/bookings/:id', requireAdmin, async (req, res) => {
  const doc = await bookingsCol.doc(req.params.id).get();
  if(!doc.exists) return res.status(404).json({ error:'Booking tidak ditemukan' });
  res.json({ ...doc.data(), id: doc.id });
});
app.put('/api/bookings/:id', requireAdmin, async (req, res) => {
  const { status, adminNote } = req.body;
  const ref = bookingsCol.doc(req.params.id);
  const doc = await ref.get();
  if(!doc.exists) return res.status(404).json({ error:'Booking tidak ditemukan' });
  const cur = doc.data();
  const update = {};
  if(status) update.status = status;
  if(adminNote!==undefined) update.adminNote = String(adminNote).slice(0,1000);
  update.updatedAt = new Date().toISOString();
  await ref.set(update, { merge:true });
  // auto ke Jadwal jika status jadi confirmed
  if(status==='confirmed' && cur.status!=='confirmed'){
    const schedData = {
      id: ref.id,
      name: cur.name,
      location: cur.location || '',
      date: cur.date,
      time: cur.time,
      note: [cur.concept?`Konsep: ${cur.concept}`:'', cur.people?`Orang: ${cur.people}`:'', cur.needs?`Kebutuhan: ${cur.needs}`:'', cur.note?`Catatan: ${cur.note}`:''].filter(Boolean).join(' | ') || cur.note || '',
      wa: cur.wa,
      people: cur.people,
      concept: cur.concept,
      bookingId: ref.id,
      createdAt: new Date().toISOString()
    };
    await schedulesCol.doc(ref.id).set(schedData, { merge:true });
    const shootData = { name: cur.name, date: cur.date, time: cur.time, location: cur.location||'', note: schedData.note, items:[], deliveryLink:null, deliveryFolderId:null, createdAt: new Date().toISOString(), bookingId: ref.id };
    // shoot id same as booking for easy link
    await shootsCol.doc(ref.id).set(shootData, { merge:true });
    await schedulesCol.doc(ref.id).set({ projectId: ref.id }, { merge:true });
  }
  if(status==='cancelled' || status==='rejected'){
    // optional: hapus jadwal yang auto dibuat? keep for now
  }
  res.json({ ok:true, id: req.params.id });
});
app.delete('/api/bookings/:id', requireAdmin, async (req, res) => {
  await bookingsCol.doc(req.params.id).delete();
  res.json({ ok:true });
});

// --- SHOWCASE API (Firestore + local uploads/showcase) ---
app.get('/api/showcase', async (req, res) => {
  const snap = await showcaseCol.orderBy('order','asc').get();
  const items = snap.docs.map(d=> ({ ...d.data(), id:d.id }));
  // sort by createdAt if order equal
  items.sort((a,b)=> (a.order||0)-(b.order||0) || (a.createdAt||'').localeCompare(b.createdAt||''));
  res.json(items);
});
app.post('/api/showcase', requireAdmin, async (req, res) => {
  // mode Drive link (tanpa judul/subjudul) — isi link folder Drive, fetch foto via Drive API
  let { driveLink, driveFolderId } = req.body;
  driveFolderId = driveFolderId || extractDriveFolderId(driveLink);
  if(!driveFolderId) return res.status(400).json({ error:'Link Drive folder tidak valid. Paste link folder Drive.' });
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
  const tokens = loadTokens();
  let photos=[];
  try{
    if(tokens){
      const drive = getDriveClient();
      let pageToken=null; let allFiles=[];
      do{
        const r = await drive.files.list({ q:`'${driveFolderId}' in parents and trashed=false`, fields:'nextPageToken, files(id,name,mimeType)', pageSize:1000, pageToken: pageToken||undefined });
        allFiles=allFiles.concat(r.data.files||[]); pageToken=r.data.nextPageToken;
      }while(pageToken);
      photos=allFiles.filter(f=>f.mimeType.startsWith('image/')).map(f=>({ driveId:f.id, filename:f.name, url:`https://drive.google.com/thumbnail?id=${f.id}&sz=w800`, title:f.name.replace(/\.[^/.]+$/,''), subtitle:'' }));
    } else if(GOOGLE_API_KEY){
      let pageToken=null; let allFiles=[];
      do{
        let url=`https://www.googleapis.com/drive/v3/files?q='${driveFolderId}'+in+parents+and+trashed=false&fields=nextPageToken,files(id,name,mimeType)&key=${GOOGLE_API_KEY}&pageSize=1000`;
        if(pageToken) url+=`&pageToken=${pageToken}`;
        const r=await fetch(url); const j=await r.json();
        if(j.error) return res.status(400).json({ error:j.error.message, hint:'Pastikan folder public (Anyone with link)' });
        allFiles=allFiles.concat(j.files||[]); pageToken=j.nextPageToken;
      }while(pageToken);
      photos=allFiles.filter(f=>f.mimeType.startsWith('image/')).map(f=>({ driveId:f.id, filename:f.name, url:`https://drive.google.com/thumbnail?id=${f.id}&sz=w800`, title:f.name.replace(/\.[^/.]+$/,''), subtitle:'' }));
    } else {
      return res.status(400).json({ error:'Butuh GOOGLE_API_KEY (public folder) atau login OAuth untuk fetch Drive.' });
    }
    if(photos.length===0) return res.status(400).json({ error:'Folder kosong atau tidak ada foto.' });
    // ganti semua showcase dengan hasil Drive
    const snap=await showcaseCol.get();
    const batch=db.batch();
    snap.docs.forEach(d=> batch.delete(d.ref));
    await batch.commit();
    const batch2=db.batch();
    photos.forEach((p,i)=>{
      const ref=showcaseCol.doc();
      batch2.set(ref, { filename:p.driveId, url:p.url, driveId:p.driveId, title:p.title, subtitle:'', order:i, driveFolderId, driveLink: driveLink||`https://drive.google.com/drive/folders/${driveFolderId}`, createdAt:new Date().toISOString() });
    });
    await batch2.commit();
    res.json({ ok:true, count:photos.length, folderId:driveFolderId });
  }catch(e){ console.error(e); res.status(500).json({ error:e.message }) }
});
app.put('/api/showcase/:id', requireAdmin, async (req, res) => {
  const { title, subtitle, order } = req.body;
  const ref = showcaseCol.doc(req.params.id);
  const doc = await ref.get();
  if(!doc.exists) return res.status(404).json({ error:'Showcase tidak ditemukan' });
  const update={};
  if(title!==undefined) update.title=String(title).slice(0,60);
  if(subtitle!==undefined) update.subtitle=String(subtitle).slice(0,60);
  if(order!==undefined) update.order=parseInt(order)||0;
  update.updatedAt=new Date().toISOString();
  await ref.set(update,{merge:true});
  res.json({ ok:true });
});
app.delete('/api/showcase/:id', requireAdmin, async (req, res) => {
  const ref = showcaseCol.doc(req.params.id);
  const doc = await ref.get();
  if(!doc.exists) return res.status(404).json({ error:'Showcase tidak ditemukan' });
  const data = doc.data();
  if(data.filename){
    const fp = path.join(showcaseDir, data.filename);
    if(fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  await ref.delete();
  res.json({ ok:true });
});

// --- IG POSTS API (preview embed di bawah agenda — dinamis, berapa di-submit segitu tampil) ---
const igCol = db.collection('igPosts');
app.get('/api/ig-posts', async (req, res) => {
  const doc = await igCol.doc('main').get();
  if(!doc.exists) return res.json({ links: [] });
  const d = doc.data();
  res.json({ links: (d.links||[]).filter(Boolean), updatedAt: d.updatedAt||null });
});
app.get('/api/admin/ig-posts', requireAdmin, async (req, res) => {
  const doc = await igCol.doc('main').get();
  if(!doc.exists) return res.json({ links: [] });
  res.json({ links: doc.data().links||[], updatedAt: doc.data().updatedAt||null });
});
app.put('/api/admin/ig-posts', requireAdmin, async (req, res) => {
  let { links } = req.body;
  if(!Array.isArray(links)) return res.status(400).json({ error:'links harus array' });
  links = links.map(s=> String(s||'').trim().slice(0,500)).filter(Boolean).slice(0,12);
  // validasi simpel: kalau isi harus mengandung instagram.com atau ig
  for(const u of links){
    if(u && !/instagram\.com|instagr\.am/i.test(u)) return res.status(400).json({ error:`Link IG tidak valid: ${u}` });
  }
  await igCol.doc('main').set({ links, updatedAt: new Date().toISOString() }, { merge:true });
  res.json({ ok:true, links });
});

app.use('/uploads', express.static(UPLOAD_DIR));

// Clean URLs: /portofolio, /portfolio -> portfolio.html (tanpa .html) — tanpa .html biar ga diliar cust
const cleanPages = ['portfolio','portofolio','owner','porto-admin','portofolio-admin','projects','schedule','jadwal','moodboard','moodboard-work','client','download'];
cleanPages.forEach(p=>{
  let file = p+'.html';
  if(p==='portofolio') file='portfolio.html';
  else if(p==='jadwal') file='schedule.html';
  else if(p==='porto-admin' || p==='portofolio-admin') file='porto-admin.html';
  app.get('/'+p, (req,res)=> res.sendFile(path.join(__dirname,'public', file)));
});
app.get('/book', (req,res)=> res.sendFile(path.join(__dirname,'public','booking.html')));
app.get('/booking', (req,res)=> res.sendFile(path.join(__dirname,'public','booking.html')));
// redirect .html ke clean URL biar ga keliatan .html
app.use((req,res,next)=>{
  if(!req.path.endsWith('.html')) return next();
  const base = path.basename(req.path, '.html');
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const cleanMap = { 'portofolio':'/portfolio', 'jadwal':'/schedule', 'porto-admin':'/porto-admin', 'portofolio-admin':'/porto-admin' };
  if(cleanMap[base]) return res.redirect(301, cleanMap[base]+q);
  if(cleanPages.includes(base)) return res.redirect(301, '/'+base+q);
  if(['booking','client','download','moodboard-work','projects','schedule','portfolio','owner','porto-admin'].includes(base)) return res.redirect(301, '/'+base+q);
  next();
});

app.use((req, res, next) => {
  const isHtml = req.path.endsWith('.html') || req.path.endsWith('.css') || req.path.endsWith('.js') || cleanPages.includes(req.path.slice(1).split('/')[0].split('?')[0]);
  if(isHtml){
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Granads Sortir Foto running at http://localhost:${PORT}`);
  console.log(`Owner: http://localhost:${PORT}/owner`);
  console.log(`Portfolio: http://localhost:${PORT}/portfolio`);
  console.log(`Book: http://localhost:${PORT}/book`);
  console.log(`Auth status: http://localhost:${PORT}/auth/status`);
});
