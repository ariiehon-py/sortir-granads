# Granads — Sortir Foto (API Key + OAuth)

## Jalankan Lokal
```bash
npm install
# isi .env dari .env.example
node server.js
# http://localhost:3000/owner.html
```

## Deploy ke Railway + Cloudflare
1. Push ke GitHub: `git init; git add .; git commit -m "deploy ready"; git push`
2. Railway → New Project → Deploy from GitHub → pilih repo
3. Variables (Railway Dashboard → Variables):
   ```
   GOOGLE_API_KEY=...
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://FOTO.GRANADS.ME/auth/callback
   FIREBASE_PROJECT_ID=...
   FIREBASE_CLIENT_EMAIL=...
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n"
   ```
4. Railway → Settings → Domains → Generate / Custom Domain → `foto.granads.me` → copy CNAME ke Cloudflare DNS (Proxy ON ☁️)
5. Google Cloud Console → Credentials → OAuth redirect URI → tambah `https://foto.granads.me/auth/callback`
6. Buka `https://foto.granads.me/auth/status` cek `configured:true`, lalu `/auth/login`
> `data/google_tokens.json` di Railway ephemeral — setelah deploy ulang perlu re-login Google sekali. Untuk persistent, tambah Volume di Railway mount ke `/app/data`.


## Setup Google (sekali)
1. https://console.cloud.google.com → New Project → Enable **Google Drive API**
2. **API Key** (untuk fetch folder public, read-only):
   - Credentials → Create Credentials → API Key → restrict ke Drive API → paste ke `.env` `GOOGLE_API_KEY`
   - Folder Drive harus `Anyone with the link - Viewer`
3. **OAuth** (untuk bikin folder hasil di Drive, write):
   - Credentials → Create Credentials → OAuth client ID → Web application
   - Authorized redirect URI: `http://localhost:3000/auth/callback` (production ganti domain)
   - Isi `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` di `.env`
   - Restart server → Owner Dashboard → **Login Google**

## Flow
- Owner: input Nama + Link Drive + Maks (soft warning) → Buat Link → kirim `client.html?id=xxx` ke client
- Fetch: tombol **Fetch Drive** pakai API Key *atau* OAuth (salah satu cukup)
- Client: pilih 1/2/3 (button + keyboard 1/2/3 + bulk centang), filter, progress soft warning
- Owner: Lihat Hasil → **Bikin Folder di Drive** → auto buat `01 - Terpilih / 02 - Dipertimbangkan / 03 - Tidak` di dalam folder induk & copy file kesana (butuh OAuth). File upload manual juga ikut ke-upload ke Drive.

## Catatan
- Tanpa API Key & tanpa OAuth: tetap bisa upload manual via tombol Upload
- API Key saja: bisa fetch public, tidak bisa bikin folder (butuh OAuth)
- OAuth saja: bisa fetch + bikin folder (tidak butuh API Key lagi)
- `data/google_tokens.json` menyimpan token (jangan commit)
