import { Firestore } from '@google-cloud/firestore';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  txt.split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  });
}

const pk = process.env.FIREBASE_PRIVATE_KEY?.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
const db = new Firestore({
  projectId: process.env.FIREBASE_PROJECT_ID,
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: pk,
  },
});
const projects = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'projects.json'), 'utf8'));

async function migrate() {
  console.log(`Migrating ${projects.length} projects...`);
  for (const p of projects) {
    await db.collection('projects').doc(p.id).set(p);
    console.log(`  Migrated: ${p.id} - ${p.clientName}`);
  }
  console.log('Done!');
  process.exit(0);
}

migrate().catch(e => { console.error(e); process.exit(1); });
