'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The archive's min-content check must survive a LARGE archive listing.
 *
 * It did not: `printf '%s\n' "$ARCHIVE_LIST" | grep -qxF "$member"` under `set -o pipefail` reports
 * a present member as missing whenever the match is early — grep exits at the first hit, printf
 * takes SIGPIPE finishing the write, and 141 becomes the pipeline's status. Every real install
 * trips it, because the whatsapp-web.js session directory is a Chromium profile of ~10k files and
 * the two database members sit near the top of the listing. The script then deletes the (perfectly
 * good) archive, so a host in this state has no backups at all and says so only as
 * "archive failed the min-content check".
 *
 * The existing smoke test asserts the same property but stages a handful of files, so its listing
 * never approaches the 64KB pipe buffer and the defect was invisible to it. This fixture's whole
 * point is the file count.
 */
const ROOT = path.join(__dirname, '..');
const BACKUP = path.join(ROOT, 'scripts', 'backup.sh');

/** Enough entries that the listing cannot fit the pipe buffer while grep exits at member #1. */
const SESSION_FILES = 4000;

test('a backup whose listing dwarfs the pipe buffer still passes its own min-content check', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-backup-'));
  try {
    const data = path.join(root, 'data');
    const sessions = path.join(data, 'sessions', 'session-main');
    fs.mkdirSync(sessions, { recursive: true });
    // Content is irrelevant; the count is the fixture. A Chromium profile has ~10k of these.
    for (let i = 0; i < SESSION_FILES; i += 1) {
      fs.writeFileSync(path.join(sessions, `entry-${i}`), 'x');
    }
    // Real databases when the CLI is here, because backup.sh uses `sqlite3 .backup` whenever it
    // can and that refuses a file that is not one; the plain-copy fallback it takes without the CLI
    // is equally fine for this fixture.
    for (const db of ['main.sqlite', 'openwa.sqlite']) {
      const file = path.join(data, db);
      const made = spawnSync('sqlite3', [file, 'create table t(x)'], { encoding: 'utf8' });
      if (made.error || made.status !== 0) fs.writeFileSync(file, db);
    }

    const out = path.join(root, 'out');
    const res = spawnSync('bash', [BACKUP], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, BACKUP_DIR: out, OPENWA_DATA_DIR: data },
    });

    assert.equal(res.status, 0, `backup.sh failed:\n${res.stdout}\n${res.stderr}`);
    const archives = fs.readdirSync(out).filter(f => f.endsWith('.tar.gz'));
    // The failure mode being guarded deletes the archive, so its absence is the regression.
    assert.equal(archives.length, 1, `expected one archive, found ${archives.length}`);

    const listing = spawnSync('tar', ['-tzf', path.join(out, archives[0])], { encoding: 'utf8' }).stdout;
    for (const member of ['./main.sqlite', './openwa.sqlite']) {
      assert.ok(listing.split('\n').includes(member), `archive is missing ${member}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
