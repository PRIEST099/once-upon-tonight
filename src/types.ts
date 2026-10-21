export type ReadingLevel = 'pre-reader' | 'early-reader' | 'independent-reader';

export interface Character {
  name: string;
  /** Visual + personality description reused in every illustration prompt for consistency. */
  description: string;
}

export interface Episode {
  storyId: string;
  date: string;
  title: string;
  summary: string;
  choiceMade?: string;
  wordOfTheNight?: string;
}

/** Everything that carries over from one night to the next. */
export interface StoryWorld {
  sidekick: Character;
  recurringCharacters: Character[];
  places: string[];
  episodes: Episode[];
}

export interface Child {
  id: string;
  familyId: string;
  name: string;
  age: number;
  readingLevel: ReadingLevel;
  appearance: string;
  favoriteThings: string[];
  /** Topics a parent never wants in a story (e.g. "spiders", "getting lost"). */
  avoid: string[];
  world: StoryWorld;
}

export interface Family {
  id: string;
  parentName: string;
  email: string;
  password: string; // demo-only; plain value so judges can sign in with the seeded family
  childIds: string[];
}

export interface SpeechMark {
  time: number; // ms from start of page audio
  start: number; // char offset in page text
  end: number;
  value: string;
}

export interface Page {
  id: string;
  text: string;
  illustrationPrompt: string;
  imageUrl?: string;
  audioUrl?: string;
  marks?: SpeechMark[];
}

export interface ChoiceOption {
  id: 'a' | 'b';
  label: string;
  pages: Page[];
}

export interface StoryChoice {
  question: string;
  questionAudioUrl?: string;
  options: [ChoiceOption, ChoiceOption];
}

export type StoryStatus = 'queued' | 'writing' | 'checking' | 'illustrating' | 'narrating' | 'ready' | 'failed';

export interface StoryRequest {
  todaysMoments: string;
  theme?: string;
  length: 'short' | 'standard';
}

export interface Playback {
  pageIndex: number;
  branch?: 'a' | 'b';
  startedAt?: string;
  finishedAt?: string;
  wordsExplored: string[];
  pagesHeard: number;
}

export interface Story {
  id: string;
  familyId: string;
  childId: string;
  createdAt: string;
  status: StoryStatus;
  progress: { step: string; done: number; total: number; log: string[] };
  error?: string;
  request: StoryRequest;
  title?: string;
  dedication?: string;
  pages: Page[];
  choice?: StoryChoice;
  wordOfTheNight?: { word: string; meaning: string; example: string; audioUrl?: string };
  episodeSummary?: string;
  newCharacters?: Character[];
  newPlaces?: string[];
  safety?: { checked: boolean; provider: string; notes?: string };
  playback: Playback;
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  /** Allow any redirect matching these prefixes (used for Alexa's regional account-linking URLs). */
  redirectPrefixes?: string[];
  public: boolean;
}

export interface AuthCode {
  code: string;
  clientId: string;
  familyId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope: string;
  expiresAt: number;
}

export interface TokenRecord {
  token: string;
  kind: 'access' | 'refresh';
  clientId: string;
  familyId: string;
  scope: string;
  resource?: string;
  expiresAt: number;
}
