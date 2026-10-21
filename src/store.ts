import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import type { AuthCode, Child, Family, OAuthClient, Story, TokenRecord } from './types.js';

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
    password: 'bedtime',
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
  } else {
    db = seed();
    saveNow();
  }
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
export const getToken = (t: string) => db.tokens[t];
export function putToken(t: TokenRecord) {
  db.tokens[t.token] = t;
  save();
}
export function deleteToken(t: string) {
  delete db.tokens[t];
  save();
}
