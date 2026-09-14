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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

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
const upload = multer({ storage });

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
  res.json({
    configured: !!oauth,
    loggedIn: !!tokens,
    email: tokens?.email || null,
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
    scope: ['https://www.googleapis.com/auth/drive']
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
app.post('/api/projects', async (req, res) => {
  const { clientName, driveLink, maxSelection, deadline } = req.body;
  if (!clientName) return res.status(400).json({ error: 'Nama client wajib' });
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

app.get('/api/projects', async (req, res) => {
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

app.post('/api/projects/:id/upload', upload.array('photos', 100), async (req, res) => {
  const doc = await projectsCol.doc(req.params.id).get();
  if (!doc.exists) return res.status(404).json({ error: 'Project tidak ditemukan' });
  res.json({ ok: true, uploaded: req.files.length });
});

// Fetch from Drive (API Key OR OAuth)
app.post('/api/projects/:id/fetch-drive', async (req, res) => {
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
app.post('/api/projects/:id/create-drive-folders', async (req,res)=>{
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

app.delete('/api/projects/:id', async (req, res) => {
  await projectsCol.doc(req.params.id).delete();
  const dir = path.join(UPLOAD_DIR, req.params.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/health', (req,res)=> res.json({ ok:true, uptime: process.uptime(), ts: new Date().toISOString() }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use((req, res, next) => {
  if(req.path.endsWith('.html') || req.path.endsWith('.css') || req.path.endsWith('.js')){
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/moodboard.html'));

app.listen(PORT, () => {
  console.log(`Granads Sortir Foto running at http://localhost:${PORT}`);
  console.log(`Owner: http://localhost:${PORT}/owner.html`);
  console.log(`Auth status: http://localhost:${PORT}/auth/status`);
});
