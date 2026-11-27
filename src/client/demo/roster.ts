export interface DemoPersona {
  readonly index: number;
  readonly displayName: string;
  readonly email: string;
  readonly avatarUrl: null;
}

export const DEMO_ROSTER: readonly DemoPersona[] = [
  { index: 1, displayName: 'Hitagi Senjougahara', email: 'hitagi.senjougahara@gmail.com', avatarUrl: null },
  { index: 2, displayName: 'Mayoi Hachikuji', email: 'mayoi.hachikuji@gmail.com', avatarUrl: null },
  { index: 3, displayName: 'Suruga Kanbaru', email: 'suruga.kanbaru@gmail.com', avatarUrl: null },
  { index: 4, displayName: 'Nadeko Sengoku', email: 'nadeko.sengoku@gmail.com', avatarUrl: null },
  { index: 5, displayName: 'Tsubasa Hanekawa', email: 'tsubasa.hanekawa@gmail.com', avatarUrl: null },
  { index: 6, displayName: 'Kiss-Shot', email: 'shinobu.oshino@gmail.com', avatarUrl: null },
  { index: 7, displayName: 'Karen Araragi', email: 'karen.araragi@gmail.com', avatarUrl: null },
  { index: 8, displayName: 'Tsukihi Araragi', email: 'tsukihi.chan@gmail.com', avatarUrl: null },
  { index: 9, displayName: 'Yotsugi Ononoki', email: 'ononoki.rulebook@gmail.com', avatarUrl: null },
  { index: 10, displayName: 'Ougi Oshino', email: 'ougi.oshino0@gmail.com', avatarUrl: null },
  { index: 11, displayName: 'Sodachi Oikura', email: 'sodachi.oikura@gmail.com', avatarUrl: null },
  { index: 12, displayName: 'Izuko Gaen', email: 'izuko.gaen@gmail.com', avatarUrl: null },
  { index: 13, displayName: 'Yozuru Kagenui', email: 'yozuru.kagenui@gmail.com', avatarUrl: null },
  { index: 14, displayName: 'Suicide-Master', email: 'deathtopia.vsm@gmail.com', avatarUrl: null },
] as const;

export const DEMO_ACCOUNT_ROSTER = DEMO_ROSTER;

const personaByEmail = new Map<string, DemoPersona>(
  DEMO_ROSTER.map((persona) => [persona.email.toLowerCase(), persona])
);

export function getPersonaByEmail(email: string): DemoPersona | undefined {
  return personaByEmail.get(email.toLowerCase());
}
