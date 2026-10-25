# Granads — Sortir Foto (API Key + OAuth)

## Jalankan Lokal
```bash
npm install
# isi .env dari .env.example
node server.js
# http://localhost:3000/owner.html
```

## Deploy ke Cloudflare (tanpa Railway)
Domain production bisa tetap `https://sortir.granads.k3unair.com`. App jalan 100% sama (Express + Firestore + Drive OAuth) di **Cloudflare Containers** — `server.js` tidak diubah sama sekali.

> Butuh **Workers Paid** plan (Containers). Butuh **Docker** nyala di mesin saat deploy (atau deploy via Workers Builds di dashboard).

1. Push ke GitHub (sama seperti cara Railway di bawah).
2. Install dependensi & login Cloudflare:
   ```powershell
   npm install
   npx wrangler login
   ```
3. Set secrets di Worker (sama isinya dengan `.env` / Railway Variables):
   ```powershell
   npx wrangler secret put GOOGLE_API_KEY
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put GOOGLE_REDIRECT_URI   # https://sortir.granads.k3unair.com/auth/callback
   npx wrangler secret put ADMIN_EMAILS
   npx wrangler secret put FIREBASE_PROJECT_ID
   npx wrangler secret put FIREBASE_CLIENT_EMAIL
   npx wrangler secret put FIREBASE_PRIVATE_KEY
   ```
4. Deploy (build image Docker + Worker):
   ```powershell
   npm run deploy
   # atau: npx wrangler deploy
   ```
   Tunggu beberapa menit provisioning container pertama kali.
5. Custom Domain: Cloudflare Dashboard → Workers & Pages → `granads-sortir` → Settings → Domains & Routes → Custom Domain → `sortir.granads.k3unair.com` (DNS otomatis di zone yang sama).
6. Google Cloud Console → Credentials → OAuth redirect URI → `https://sortir.granads.k3unair.com/auth/callback`
7. Cek `https://sortir.granads.k3unair.com/auth/status` → `configured:true`, lalu `/auth/login`.

File terkait Cloudflare: `wrangler.toml`, `Dockerfile`, `src/worker.js` (Worker cuma proxy ke container; isi app tetap `server.js`).

> Catatan: token OAuth (`data/google_tokens.json`) & upload lokal disimpan di disk container — kalau container sleep/wake, file bisa hilang (mirip ephemeral Railway). Kalau butuh persistent, pakai Volume (Railway) atau pindahin storage ke Drive/Firestore.

## Deploy ke Railway + Cloudflare (opsional, masih didukung)
Domain production: `https://sortir.granads.k3unair.com`
1. Push ke GitHub (tanpa `gh`, via browser):
   ```powershell
   git init; git add .; git commit -m "deploy: railway + catatan Dipilih only"
   # lalu buat repo di github.com/new (nama: granads-sortir, public), terus:
   git remote add origin https://github.com/USERNAME_KAMU/granads-sortir.git
   git branch -M main; git push -u origin main
   ```
2. Railway → New Project → Deploy from GitHub → pilih repo
3. Variables (Railway Dashboard → Variables):
   ```
   GOOGLE_API_KEY=...
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://sortir.granads.k3unair.com/auth/callback
   FIREBASE_PROJECT_ID=...
   FIREBASE_CLIENT_EMAIL=...
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n"
   ```
4. Railway → Settings → Domains → Custom Domain → `sortir.granads.k3unair.com` → copy CNAME ke Cloudflare DNS (zone `k3unair.com`, name `sortir.granads`, Proxy ON ☁️)
5. Google Cloud Console → Credentials → OAuth redirect URI → tambah `https://sortir.granads.k3unair.com/auth/callback`
6. Buka `https://sortir.granads.k3unair.com/auth/status` cek `configured:true`, lalu `/auth/login`
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
