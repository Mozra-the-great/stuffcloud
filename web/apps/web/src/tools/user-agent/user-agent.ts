/**
 * User-agent parser (T-19, issue #24): browser, engine, operating system, device and CPU architecture
 * from a `User-Agent` string, with own rules and no library.
 *
 * Why no library: `ua-parser-js` is MIT up to version 1 and AGPL-3.0 from version 2 (SPEC 3), and the
 * uap-core rule file is a large data file for what a toolbox page needs. The rules below cover the
 * browsers, systems and devices of the test corpus (`tests/tools/user-agent-corpus.ts`); a string
 * they do not know comes back with the missing parts left out, never with a guess.
 *
 * A user-agent string is whatever the client chose to send; the result is a hint, not proof.
 * Pure functions, no I/O, nothing here throws for any input.
 */

export type DeviceType =
  'desktop' | 'mobile' | 'tablet' | 'tv' | 'console' | 'wearable' | 'bot' | 'library' | 'unknown';

/** Something the string says that is easy to misread; the tool turns each code into a sentence. */
export type UserAgentNote = 'windows-10-11' | 'frozen-macos' | 'reduced-device';

export interface Named {
  readonly name: string;
  readonly version: string | undefined;
}

export interface DeviceInfo {
  readonly type: DeviceType;
  readonly vendor: string | undefined;
  readonly model: string | undefined;
}

export interface UserAgentInfo {
  readonly browser: Named | undefined;
  readonly engine: Named | undefined;
  readonly os: Named | undefined;
  readonly device: DeviceInfo;
  readonly cpu: string | undefined;
  readonly notes: readonly UserAgentNote[];
}

/** Longer texts are cut off before they are looked at (real strings are well below 1 000). */
export const MAX_USER_AGENT_LENGTH = 2000;

type Rule = readonly [name: string, pattern: RegExp];

/** Crawlers and link-preview fetchers: tried first, because most of them also say "Chrome". */
const BOTS: readonly Rule[] = [
  ['Googlebot', /\b(?:Googlebot(?:-[A-Za-z]+)?|AdsBot-Google|Mediapartners-Google)\/([\d.]+)/],
  ['Googlebot', /\bGooglebot\b()/],
  ['Google-InspectionTool', /\bGoogle-InspectionTool\/([\d.]+)/],
  ['Bingbot', /\bbingbot\/([\d.]+)/i],
  ['Yahoo! Slurp', /\bSlurp\b()/],
  ['DuckDuckBot', /\bDuckDuckBot\/([\d.]+)/],
  ['Baiduspider', /\bBaiduspider\/([\d.]+)/],
  ['YandexBot', /\bYandex(?:Bot|Images|Direct)\/([\d.]+)/],
  ['facebookexternalhit', /\bfacebookexternalhit\/([\d.]+)/],
  ['Twitterbot', /\bTwitterbot\/([\d.]+)/],
  ['LinkedInBot', /\bLinkedInBot\/([\d.]+)/],
  ['Slackbot', /\bSlack(?:bot|bot-LinkExpanding|-ImgProxy)\/([\d.]+)/],
  ['Applebot', /\bApplebot\/([\d.]+)/],
  ['GPTBot', /\bGPTBot\/([\d.]+)/],
  ['ClaudeBot', /\bClaudeBot\/([\d.]+)/],
  ['CCBot', /\bCCBot\/([\d.]+)/],
  ['PerplexityBot', /\bPerplexityBot\/([\d.]+)/],
  ['AhrefsBot', /\bAhrefsBot\/([\d.]+)/],
  ['SemrushBot', /\bSemrushBot\/([\d.]+)/],
  ['Bytespider', /\bBytespider\b()/],
  ['PetalBot', /\bPetalBot\b()/],
  ['UptimeRobot', /\bUptimeRobot\/([\d.]+)/],
  ['Discordbot', /\bDiscordbot\/([\d.]+)/],
  ['TelegramBot', /\bTelegramBot\b/],
];

/** Any other name ending in bot, crawler or spider. */
const GENERIC_BOT = /\b([A-Za-z][A-Za-z0-9_-]{0,30}(?:bot|crawler|spider))\b(?:\/([\d.]+))?/i;

/** HTTP clients, scripts and command-line tools: they start the string with their name. */
const LIBRARIES: readonly Rule[] = [
  ['curl', /^curl\/([\w.]+)/i],
  ['Wget', /^Wget\/([\w.]+)/i],
  ['HTTPie', /^HTTPie\/([\w.]+)/i],
  ['python-requests', /^python-requests\/([\w.]+)/i],
  ['Python urllib', /^Python-urllib\/([\w.]+)/i],
  ['aiohttp', /^Python\/[\d.]+ aiohttp\/([\w.]+)/i],
  ['Go http client', /^Go-http-client\/([\w.]+)/i],
  ['node-fetch', /^node-fetch\/([\w.]+)/i],
  ['axios', /^axios\/([\w.]+)/i],
  ['undici', /^undici()$/i],
  ['okhttp', /^okhttp\/([\w.]+)/i],
  ['Apache HttpClient', /^Apache-HttpClient\/([\w.]+)/i],
  ['Java', /^Java\/([\w._]+)/i],
  ['libwww-perl', /^libwww-perl\/([\w.]+)/i],
  ['PostmanRuntime', /^PostmanRuntime\/([\w.]+)/i],
  ['Insomnia', /^insomnia\/([\w.]+)/i],
  ['Dart', /^Dart\/([\w.]+)/i],
  ['Lynx', /^Lynx\/([\w.]+)/i],
];

/** Browsers in the order they have to be tried: the ones that also say "Chrome" or "Safari" first. */
const BROWSERS: readonly Rule[] = [
  ['Edge', /\bEdg(?:A|iOS)?\/([\d.]+)/],
  ['Edge (legacy)', /\bEdge\/([\d.]+)/],
  ['Opera Mini', /\bOpera Mini\/([\d.]+)/],
  ['Opera', /\b(?:OPR|OPiOS|OPT)\/([\d.]+)/],
  ['Opera', /^Opera\/[\d.]+[\s\S]{0,100}?Version\/([\d.]+)/],
  ['Opera', /^Opera\/([\d.]+)/],
  ['Samsung Internet', /\bSamsungBrowser\/([\d.]+)/],
  ['Vivaldi', /\bVivaldi\/([\d.]+)/],
  ['DuckDuckGo', /\bDuckDuckGo\/([\d.]+)/],
  ['Yandex Browser', /\bYaBrowser\/([\d.]+)/],
  ['UC Browser', /\bUCBrowser\/([\d.]+)/],
  ['Firefox Focus', /\bFocus\/([\d.]+)/],
  ['Silk', /\bSilk\/([\d.]+)/],
  ['Nintendo Browser', /\bNintendoBrowser\/([\d.]+)/],
  ['Facebook app', /\bFBAV\/([\d.]+)/],
  ['Instagram app', /\bInstagram ([\d.]+)/],
  ['WeChat', /\bMicroMessenger\/([\d.]+)/],
  ['Electron', /\bElectron\/([\d.]+)/],
  ['Headless Chrome', /\bHeadlessChrome\/([\d.]+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/([\d.]+)/],
  ['Android WebView', /; wv\)[\s\S]{0,200}?Chrome\/([\d.]+)/],
  ['Chromium', /\bChromium\/([\d.]+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/([\d.]+)/],
  ['Internet Explorer', /\bMSIE ([\d.]+)/],
  ['Internet Explorer', /\bTrident\/[\d.]+[\s\S]{0,200}?rv:([\d.]+)/],
  ['Safari', /\bVersion\/([\d.]+)[\s\S]{0,100}?Safari\//],
];

function firstMatch(rules: readonly Rule[], text: string): Named | undefined {
  for (const [name, pattern] of rules) {
    const match = pattern.exec(text);
    if (match !== null) {
      const version = match[1];
      return { name, version: version === undefined || version === '' ? undefined : version };
    }
  }
  return undefined;
}

function toNamed(name: string, version: string | undefined): Named {
  return { name, version: version === undefined || version === '' ? undefined : version };
}

function parseBrowser(ua: string): { named: Named | undefined; type: DeviceType | undefined } {
  const library = firstMatch(LIBRARIES, ua);
  if (library !== undefined) {
    return { named: library, type: 'library' };
  }
  const bot = firstMatch(BOTS, ua);
  if (bot !== undefined) {
    return { named: bot, type: 'bot' };
  }
  const generic = GENERIC_BOT.exec(ua);
  if (generic?.[1] !== undefined) {
    return { named: toNamed(generic[1], generic[2]), type: 'bot' };
  }
  const browser = firstMatch(BROWSERS, ua);
  if (browser !== undefined) {
    return { named: browser, type: undefined };
  }
  // An iPhone app that embeds a web view says "AppleWebKit" and "Mobile", but not "Safari".
  if (/\bAppleWebKit\//.test(ua) && /\bMobile\//.test(ua) && !/\bSafari\//.test(ua)) {
    return { named: { name: 'iOS WebView', version: undefined }, type: undefined };
  }
  return { named: undefined, type: undefined };
}

function isIos(ua: string): boolean {
  return /\b(?:iPhone|iPad|iPod)\b/.test(ua);
}

function parseEngine(ua: string): Named | undefined {
  const trident = /\bTrident\/([\d.]+)/.exec(ua);
  if (trident !== null) {
    return toNamed('Trident', trident[1]);
  }
  const edgeHtml = /\bEdge\/([\d.]+)/.exec(ua);
  if (edgeHtml !== null) {
    return toNamed('EdgeHTML', edgeHtml[1]);
  }
  const presto = /\bPresto\/([\d.]+)/.exec(ua);
  if (presto !== null) {
    return toNamed('Presto', presto[1]);
  }
  const webkit = /\bAppleWebKit\/([\d.]+)/.exec(ua);
  if (/\bGecko\/\d/.test(ua) && /\bFirefox\//.test(ua) && webkit === null) {
    return toNamed('Gecko', /\brv:([\d.]+)/.exec(ua)?.[1] ?? /\bFirefox\/([\d.]+)/.exec(ua)?.[1]);
  }
  if (isIos(ua) && webkit !== null) {
    return toNamed('WebKit', webkit[1]);
  }
  const chrome = /\b(?:Chrome|Chromium|HeadlessChrome)\/([\d.]+)/.exec(ua);
  if (chrome !== null && webkit !== null) {
    return toNamed('Blink', chrome[1]);
  }
  return webkit === null ? undefined : toNamed('WebKit', webkit[1]);
}

const WINDOWS_NT: Readonly<Record<string, string>> = {
  '10.0': '10 or 11',
  '6.4': '10',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
  '6.0': 'Vista',
  '5.2': 'XP x64',
  '5.1': 'XP',
  '5.0': '2000',
};

const LINUX_DISTRIBUTIONS: readonly Rule[] = [
  ['Ubuntu', /\bUbuntu(?:\/([\d.]+))?/],
  ['Fedora', /\bFedora(?:\/([\d.]+))?/],
  ['Debian', /\bDebian(?:\/([\d.]+))?/],
  ['openSUSE', /\b(?:openSUSE|SUSE)(?:\/([\d.]+))?/],
  ['CentOS', /\bCentOS(?:\/([\d.]+))?/],
  ['Red Hat', /\bRed Hat(?:\/([\d.]+))?/],
  ['Linux Mint', /\bMint(?:\/([\d.]+))?/],
  ['Gentoo', /\bGentoo\b()/],
  ['FreeBSD', /\bFreeBSD\b()/],
  ['OpenBSD', /\bOpenBSD\b()/],
  ['NetBSD', /\bNetBSD\b()/],
];

function dotted(version: string | undefined): string | undefined {
  return version?.replaceAll('_', '.');
}

function majorOf(version: string | undefined): number {
  return Number.parseInt(version ?? '', 10);
}

function parseOs(ua: string): Named | undefined {
  const windowsPhone = /\bWindows Phone (?:OS )?([\d.]+)/.exec(ua);
  if (windowsPhone !== null) {
    return toNamed('Windows Phone', windowsPhone[1]);
  }
  const windows = /\bWindows NT ([\d.]+)/.exec(ua);
  if (windows !== null) {
    const nt = windows[1] ?? '';
    return toNamed('Windows', WINDOWS_NT[nt] ?? nt);
  }
  const oldWindows = /\bWin(?:dows )?(98|95|ME|2000)\b/.exec(ua);
  if (oldWindows !== null) {
    return toNamed('Windows', oldWindows[1]);
  }
  const harmony = /\b(?:OpenHarmony|HarmonyOS)(?: ([\d.]+))?/.exec(ua);
  if (harmony !== null) {
    return toNamed('HarmonyOS', harmony[1]);
  }
  const kaios = /\bKaiOS\/([\d.]+)/i.exec(ua);
  if (kaios !== null) {
    return toNamed('KaiOS', kaios[1]);
  }
  const android = /\bAndroid(?:[ -]([\d.]+))?/.exec(ua);
  if (android !== null) {
    return toNamed('Android', android[1]);
  }
  const ios = /\bOS ([\d_]+) like Mac OS X/.exec(ua);
  if (ios !== null || isIos(ua)) {
    const version = dotted(ios?.[1]);
    return toNamed(/\biPad\b/.test(ua) && majorOf(version) >= 13 ? 'iPadOS' : 'iOS', version);
  }
  const chromeOs = /\bCrOS \S+ ([\d.]+)/.exec(ua);
  if (chromeOs !== null) {
    return toNamed('ChromeOS', chromeOs[1]);
  }
  if (/\bCrOS\b/.test(ua)) {
    return toNamed('ChromeOS', undefined);
  }
  const mac = /\bMac OS X ([\d_.]+)/.exec(ua);
  if (mac !== null) {
    return toNamed('macOS', dotted(mac[1]));
  }
  if (/\bMacintosh\b/.test(ua)) {
    return toNamed('macOS', undefined);
  }
  const tizen = /\bTizen[ /]([\d.]+)/.exec(ua);
  if (tizen !== null) {
    return toNamed('Tizen', tizen[1]);
  }
  if (/\bWeb0S\b|\bwebOS\b/i.test(ua)) {
    return toNamed('webOS', undefined);
  }
  if (/\bPlayStation\b/.test(ua)) {
    return toNamed('PlayStation', /\bPlayStation[ /]?([\w.]+)/.exec(ua)?.[1]);
  }
  if (/\bXbox\b/.test(ua)) {
    return toNamed('Xbox', undefined);
  }
  const nintendo = /\bNintendo (Switch|3DS|Wii U|WiiU|DSi)\b/.exec(ua);
  if (nintendo !== null) {
    return toNamed(`Nintendo ${nintendo[1] ?? ''}`.trim(), undefined);
  }
  const distribution = firstMatch(LINUX_DISTRIBUTIONS, ua);
  if (distribution !== undefined) {
    return distribution;
  }
  if (/\bLinux\b|\bX11\b/.test(ua)) {
    return toNamed('Linux', undefined);
  }
  return undefined;
}

function parseCpu(ua: string): string | undefined {
  if (/\b(?:arm64|aarch64|ARM64)\b/.test(ua)) {
    return 'ARM64';
  }
  if (/\b(?:x86[_-]64|x64|amd64|WOW64)\b/i.test(ua)) {
    return 'x86-64';
  }
  if (/\b(?:armv\d+[a-z]?|armeabi[\w-]*)\b|;\s*ARM[;)]/i.test(ua)) {
    return 'ARM';
  }
  if (/\b(?:i[3-6]86|x86)\b/.test(ua)) {
    return 'x86';
  }
  return undefined;
}

const ANDROID_VENDORS: readonly (readonly [RegExp, string])[] = [
  [/^(?:SM-|GT-|SCH-|SGH-|SHV-|SAMSUNG|Galaxy)/i, 'Samsung'],
  [/^(?:Pixel|Nexus)/, 'Google'],
  [/^(?:Redmi|POCO|Mi |MI |M\d{4}[A-Z]\d{1,2}[A-Z]{1,3}$)/, 'Xiaomi'],
  [/^HUAWEI/i, 'Huawei'],
  [/^HONOR/i, 'Honor'],
  [/^(?:OnePlus|ONEPLUS)/, 'OnePlus'],
  [/^(?:moto|Motorola|XT\d{4})/i, 'Motorola'],
  [/^Nokia/i, 'Nokia'],
  [/^(?:Xperia|Sony|SO-\d|SOV\d|XQ-)/i, 'Sony'],
  [/^(?:LG-|LM-|LGE)/, 'LG'],
  [/^(?:CPH\d|OPPO)/i, 'OPPO'],
  [/^(?:vivo)/i, 'vivo'],
  [/^(?:RMX\d|realme)/i, 'realme'],
  [/^(?:ASUS|ZenFone)/i, 'ASUS'],
  [/^Lenovo/i, 'Lenovo'],
  [/^Fairphone/i, 'Fairphone'],
  [/^(?:KF[A-Z]{2,5}|Kindle)\b/, 'Amazon'],
];

/** The text up to the parenthesis that closes the one it is in ("moto g(30)" stays whole). */
function untilClosing(text: string): string {
  let depth = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '(') {
      depth += 1;
    } else if (text[at] === ')') {
      if (depth === 0) {
        return text.slice(0, at);
      }
      depth -= 1;
    }
  }
  return text;
}

/** The model after "Android 13;" (older strings put a locale such as `en-us` in between). */
function androidModel(ua: string): string | undefined {
  const start = /\bAndroid(?: [\d.]+)?;/.exec(ua);
  if (start === null) {
    return undefined;
  }
  const rest = ua.slice(start.index + start[0].length);
  const parts = untilClosing(rest)
    .split(';')
    .map((part) => part.trim());
  // Segments that are not the model: a locale (`en-us`), flags and the engine's `rv:`.
  const notModel = /^(?:[a-z]{2}(?:[-_][a-zA-Z]{2})?|wv|Mobile|Tablet|TV|U|rv:.*)$/;
  const candidate = parts.find((part) => part !== '' && !notModel.test(part));
  if (candidate === undefined) {
    return undefined;
  }
  const model = candidate
    .replace(/\s+Build\/.*$/, '')
    .replace(/^SAMSUNG\s+/i, '')
    .trim();
  return model === '' || model.includes('/') ? undefined : model;
}

function vendorOf(model: string): string | undefined {
  return ANDROID_VENDORS.find(([pattern]) => pattern.test(model))?.[1];
}

/** Systems whose browsers run on a desktop or laptop computer. */
const DESKTOP_SYSTEMS: ReadonlySet<string> = new Set([
  'Windows',
  'ChromeOS',
  'Linux',
  'Ubuntu',
  'Fedora',
  'Debian',
  'openSUSE',
  'CentOS',
  'Red Hat',
  'Linux Mint',
  'Gentoo',
  'FreeBSD',
  'OpenBSD',
  'NetBSD',
]);

function parseDevice(ua: string, os: Named | undefined): { device: DeviceInfo; reduced: boolean } {
  const device = (
    type: DeviceType,
    vendor?: string,
    model?: string,
    reduced = false,
  ): { device: DeviceInfo; reduced: boolean } => ({ device: { type, vendor, model }, reduced });

  if (/\biPad\b/.test(ua)) {
    return device('tablet', 'Apple', 'iPad');
  }
  if (/\biPod\b/.test(ua)) {
    return device('mobile', 'Apple', 'iPod touch');
  }
  if (/\biPhone\b/.test(ua)) {
    return device('mobile', 'Apple', 'iPhone');
  }
  if (/\bPlayStation\b|\bXbox\b|\bNintendo\b/.test(ua)) {
    const vendor = /\bPlayStation\b/.test(ua)
      ? 'Sony'
      : /\bXbox\b/.test(ua)
        ? 'Microsoft'
        : 'Nintendo';
    return device('console', vendor);
  }
  if (/\bTizen\b/.test(ua) && /\bSMART-?TV\b/i.test(ua)) {
    return device('tv', 'Samsung');
  }
  if (/\bWeb0S\b|\bwebOS\.TV\b/i.test(ua)) {
    return device('tv', 'LG');
  }
  if (/\b(?:SmartTV|SMART-TV|HbbTV|Roku|BRAVIA|AppleTV|CrKey|AFT[A-Z]{1,3}\b)/.test(ua)) {
    return device('tv', /\bAFT/.test(ua) ? 'Amazon' : undefined);
  }
  if (/\b(?:watchOS|Wear OS|Android Wear)\b/.test(ua)) {
    return device('wearable');
  }
  if (os?.name === 'Android' || /\bSilk\//.test(ua)) {
    const model = androidModel(ua);
    // Chrome 110+ replaces the model with a single letter.
    const reduced = model === 'K';
    const shown = reduced ? undefined : model;
    const vendor = shown === undefined ? undefined : vendorOf(shown);
    const type: DeviceType = /\bMobile\b|\bOpera Mini\b|\bOpera Mobi\b/.test(ua)
      ? 'mobile'
      : 'tablet';
    return device(type, vendor, shown, reduced);
  }
  if (os?.name === 'Windows Phone' || os?.name === 'KaiOS' || /\bMobile\b/.test(ua)) {
    return device('mobile');
  }
  if (os?.name === 'macOS') {
    return device('desktop', 'Apple', 'Mac');
  }
  if (os !== undefined && DESKTOP_SYSTEMS.has(os.name)) {
    return device('desktop');
  }
  return device('unknown');
}

/** The browser, engine, operating system, device and CPU architecture a user-agent string names. */
export function parseUserAgent(input: string): UserAgentInfo {
  const ua = input.trim().slice(0, MAX_USER_AGENT_LENGTH);
  const parsed = parseBrowser(ua);
  const os = parseOs(ua);
  const { device, reduced } = parseDevice(ua, os);
  const type = parsed.type ?? device.type;
  const notes: UserAgentNote[] = [];
  if (os?.name === 'Windows' && os.version === '10 or 11') {
    notes.push('windows-10-11');
  }
  if (os?.name === 'macOS' && os.version === '10.15.7') {
    notes.push('frozen-macos');
  }
  if (reduced) {
    notes.push('reduced-device');
  }
  return {
    browser: parsed.named,
    engine: parseEngine(ua),
    os,
    device: { ...device, type },
    cpu: parseCpu(ua),
    notes,
  };
}
