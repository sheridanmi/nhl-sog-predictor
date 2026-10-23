/**
 * EXPORT SETTLED SNAPSHOTS
 *
 * Dumps every settled snapshot from this season's v3 model to a JSON file so it
 * can be analyzed/recalibrated offline. Read-only: it never writes to Firestore.
 *
 * Setup (same env vars your settle/save scripts already use):
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *
 * Usage (from the repo root, where firebase-admin is installed):
 *   npm install firebase-admin --no-save
 *   node scripts/export-snapshots.cjs    -> writes snapshots-export.json (or $OUT)
 *
 * Reads: one pass over the snapshots collection (a few thousand docs at most).
 */

const fs = require('fs');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const SEASON_START_DATE = '2026-09-29';
const OUT = process.env.OUT || 'snapshots-export.json';

const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = getFirestore(app);

(async () => {
  const snap = await db.collection('snapshots').where('gameDate', '>=', SEASON_START_DATE).get();
  const rows = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => (s.modelVersion || '').startsWith('v3'))
    .map(s => {
      // Firestore Timestamps -> ISO strings so the file is plain JSON
      for (const k of Object.keys(s)) {
        if (s[k] && typeof s[k].toDate === 'function') s[k] = s[k].toDate().toISOString();
      }
      return s;
    });
  fs.writeFileSync(OUT, JSON.stringify(rows));
  const settled = rows.filter(r => r.settled).length;
  console.log(`Wrote ${rows.length} snapshots (${settled} settled) to ${OUT}`);
  process.exit(0);
})().catch(e => { console.error('Export failed:', e.message); process.exit(1); });
