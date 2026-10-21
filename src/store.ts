import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import type { AuthCode, Child, Family, OAuthClient, Story, StoryStatus, TokenRecord } from './types.js';

/**
 * A deliberately small JSON-file store. Everything a judge needs to run the project locally
 * lives in ./data — no database to provision. Swap for DynamoDB by re-implementing this module.
 */
interface Db {
  families: Record<string, Family>;
  children: Record<string, Child>;
  stories: Record<string, Story>;
  clients: Record<string, OAuthClient>;
  codes: Record<string, AuthCode>;
  tokens: Record<string, TokenRecord>;
  /** Per-family timestamps of paid story creations (cost guard); deliberately survives story deletion. */
  creations?: Record<string, number[]>;
}

const dbFile = path.join(config.dataDir, 'db.json');
let db: Db;
let saveTimer: NodeJS.Timeout | undefined;

export const DEMO_FAMILY_ID = 'fam_rivera';
export const DEMO_CHILD_ID = 'child_maya';

function seed(): Db {
  const family: Family = {
    id: DEMO_FAMILY_ID,
    parentName: 'Sam Rivera',
    email: 'parent@example.com',
    ...hashPassword('bedtime'),
    childIds: [DEMO_CHILD_ID],
  };
  const maya: Child = {
    id: DEMO_CHILD_ID,
    familyId: DEMO_FAMILY_ID,
    name: 'Maya',
    age: 5,
    readingLevel: 'early-reader',
    appearance: 'a five-year-old Black girl with curly dark hair in two puffs, wearing yellow star pajamas',
    favoriteThings: ['the moon', 'strawberries', 'building pillow forts'],
    avoid: ['spiders', 'getting lost'],
    world: {
      sidekick: {
        name: 'Pip',
        description:
          'a tiny round sky-blue dragon with stubby wings, a pale yellow belly and big friendly eyes; when Pip is nervous, golden sparkles hiccup out of their nose',
      },
      recurringCharacters: [],
      places: ['the Pillow Fort', 'Moonberry Hill'],
      episodes: [],
    },
  };
  return {
    families: { [family.id]: family },
    children: { [maya.id]: maya },
    stories: {},
    clients: {},
    codes: {},
    tokens: {},
  };
}

export function loadDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(dbFile)) {
    db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    if (migrate()) saveNow();
  } else {
    db = seed();
    saveNow();
  }
}

const UNFINISHED: StoryStatus[] = ['queued', 'writing', 'checking', 'illustrating', 'narrating'];

/** Bring a db.json written by an older (or crashed) server up to date. Returns true if anything changed. */
function migrate() {
  let changed = false;
  // Plaintext passwords → scrypt hash + salt.
  for (const f of Object.values(db.families) as (Family & { password?: string })[]) {
    if (typeof f.password !== 'string') continue;
    if (!f.passwordHash) Object.assign(f, hashPassword(f.password));
    delete f.password;
    changed = true;
  }
  // Tokens are keyed by sha256(token); raw legacy tokens are dropped (those clients simply re-link).
  for (const [key, t] of Object.entries(db.tokens)) {
    if (t.tokenHash !== key || 'token' in t) {
      delete db.tokens[key];
      changed = true;
    }
  }
  // A story mid-generation when the process died will never finish; say so instead of spinning forever.
  for (const s of Object.values(db.stories)) {
    if (!UNFINISHED.includes(s.status)) continue;
    s.status = 'failed';
    s.error = 'Interrupted by a server restart. Please ask again.';
    s.progress.step = `Something went wrong: ${s.error}`;
    s.progress.log.push(s.progress.step);
    changed = true;
  }
  return pruneExpired(false) > 0 || changed;
}

function saveNow() {
  fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(dbFile + '.tmp', dbFile);
}

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

// ---- families & children -------------------------------------------------------------

const scryptAsync = (password: string, salt: Buffer, keylen: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key))));

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return { passwordHash: scryptSync(password, salt, 64).toString('base64'), passwordSalt: salt.toString('base64') };
}

/** Same-cost dummy used when the email is unknown, so response time doesn't reveal which emails exist. */
const DUMMY_PASSWORD = hashPassword(randomUUID());

/** Look up a parent by email and check their password (scrypt runs off the event loop). */
export async function verifyFamilyLogin(email: string, password: string): Promise<Family | undefined> {
  const family = findFamilyByEmail(email);
  const { passwordHash, passwordSalt } = family ?? DUMMY_PASSWORD;
  const expected = Buffer.from(passwordHash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(passwordSalt, 'base64'), expected.length);
  return family && timingSafeEqual(actual, expected) ? family : undefined;
}

export const getFamily = (id: string) => db.families[id];
export const findFamilyByEmail = (email: string) =>
  Object.values(db.families).find((f) => f.email.toLowerCase() === email.trim().toLowerCase());
export const getChild = (id: string) => db.children[id];
export const childrenOf = (familyId: string) =>
  (db.families[familyId]?.childIds ?? []).map((id) => db.children[id]).filter(Boolean);

/** Resolve a spoken child name ("Maya", "maya's") to a child in this family; default to the only child. */
export function resolveChild(familyId: string, name?: string): Child | undefined {
  const kids = childrenOf(familyId);
  if (!name) return kids[0];
  const needle = name.toLowerCase().replace(/['’]s\b/, '').trim();
  return kids.find((k) => k.name.toLowerCase() === needle) ?? kids.find((k) => needle.includes(k.name.toLowerCase()));
}

export function updateChild(child: Child) {
  db.children[child.id] = child;
  save();
}

// ---- stories -------------------------------------------------------------------------

export const getStory = (id: string) => db.stories[id];
export function putStory(story: Story) {
  db.stories[story.id] = story;
  save();
}
export const storiesFor = (childId: string) =>
  Object.values(db.stories)
    .filter((s) => s.childId === childId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const latestReadyStory = (childId: string) => storiesFor(childId).find((s) => s.status === 'ready');
/** Privacy: remove every story (and its media) for a child. Returns how many were deleted. */
export function deleteStoriesFor(childId: string) {
  const doomed = storiesFor(childId);
  for (const s of doomed) {
    delete db.stories[s.id];
    fs.rmSync(path.join(config.dataDir, 'media', s.id), { recursive: true, force: true });
  }
  save();
  return doomed.length;
}

/** Cost guard: remember when a family started a paid story (kept even if the stories are deleted). */
export function recordCreation(familyId: string) {
  const log = ((db.creations ??= {})[familyId] ??= []);
  log.push(Date.now());
  const day = Date.now() - 24 * 60 * 60 * 1000;
  db.creations[familyId] = log.filter((t) => t > day);
  save();
}
export const creationsSince = (familyId: string, ms: number) => (db.creations?.[familyId] ?? []).filter((t) => t > Date.now() - ms).length;

// ---- oauth ---------------------------------------------------------------------------

export const getClient = (id: string) => db.clients[id];
export function putClient(c: OAuthClient) {
  db.clients[c.clientId] = c;
  save();
}
export const takeCode = (code: string) => {
  const c = db.codes[code];
  delete db.codes[code];
  save();
  return c;
};
export function putCode(c: AuthCode) {
  db.codes[c.code] = c;
  save();
}
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** Look up a token by the raw value a client presented. */
export const getToken = (token: string): TokenRecord | undefined => db.tokens[hashToken(token)];
/** Store a newly minted token; only its hash is persisted. */
export function putToken(token: string, t: Omit<TokenRecord, 'tokenHash'>) {
  const tokenHash = hashToken(token);
  db.tokens[tokenHash] = { tokenHash, ...t };
  save();
}
export function markRotated(tokenHash: string) {
  const t = db.tokens[tokenHash];
  if (t) t.rotatedAt = Date.now();
  save();
}
export function deleteToken(tokenHash: string) {
  delete db.tokens[tokenHash];
  save();
}
/** Revoke every token a client holds for a family (refresh-token reuse). Returns how many were removed. */
export function revokeGrant(clientId: string, familyId: string) {
  let n = 0;
  for (const [key, t] of Object.entries(db.tokens)) {
    if (t.clientId === clientId && t.familyId === familyId) {
      delete db.tokens[key];
      n++;
    }
  }
  save();
  return n;
}
/** Drop expired tokens and authorization codes. Returns how many were removed. */
export function pruneExpired(persist = true) {
  const now = Date.now();
  let n = 0;
  for (const table of [db.tokens, db.codes] as Record<string, { expiresAt: number }>[]) {
    for (const [key, v] of Object.entries(table)) {
      if (v.expiresAt < now) {
        delete table[key];
        n++;
      }
    }
  }
  // A rotated refresh token only matters for reuse detection; after a day, drop it.
  for (const [key, t] of Object.entries(db.tokens)) {
    if (t.rotatedAt && t.rotatedAt < now - 24 * 60 * 60 * 1000) {
      delete db.tokens[key];
      n++;
    }
  }
  if (n && persist) save();
  return n;
}
