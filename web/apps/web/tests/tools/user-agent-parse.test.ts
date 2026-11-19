import { describe, expect, it } from 'vitest';
import {
  MAX_USER_AGENT_LENGTH,
  parseUserAgent,
  type UserAgentInfo,
} from '../../src/tools/user-agent/user-agent.ts';
import { CORPUS } from './user-agent-corpus.ts';

const CHROME = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

describe('the corpus of real user-agent strings', () => {
  it('has enough of them, each once', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CORPUS.map((entry) => entry.ua)).size).toBe(CORPUS.length);
  });

  it.each(CORPUS.map((entry) => [entry.ua.slice(0, 90), entry] as const))('%s', (_name, entry) => {
    expect(parseUserAgent(entry.ua)).toEqual(entry.expected);
  });

  it('covers every kind of device the parser knows', () => {
    const types = new Set(CORPUS.map((entry) => entry.expected.device.type));
    for (const type of [
      'desktop',
      'mobile',
      'tablet',
      'tv',
      'console',
      'bot',
      'library',
      'unknown',
    ]) {
      expect(types, type).toContain(type);
    }
  });
});

describe('browsers', () => {
  const browser = (ua: string): string | undefined => {
    const found = parseUserAgent(ua).browser;
    return found === undefined ? undefined : `${found.name} ${found.version ?? ''}`.trim();
  };

  it.each([
    [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME} Edg/119.0.2151.44`, 'Edge 119.0.2151.44'],
    [`Mozilla/5.0 (Windows NT 10.0) ${CHROME} OPR/104.0.0.0`, 'Opera 104.0.0.0'],
    [`Mozilla/5.0 (Windows NT 10.0) ${CHROME} Vivaldi/6.4`, 'Vivaldi 6.4'],
    [`Mozilla/5.0 (Windows NT 10.0) ${CHROME} YaBrowser/23.11.0`, 'Yandex Browser 23.11.0'],
    [`Mozilla/5.0 (Linux; Android 13) ${CHROME} UCBrowser/15.5.0`, 'UC Browser 15.5.0'],
    [`Mozilla/5.0 (Linux; Android 13) ${CHROME} Focus/8.0`, 'Firefox Focus 8.0'],
    [`Mozilla/5.0 (Windows NT 10.0) ${CHROME}`, 'Chrome 119.0.0.0'],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/119.0.0.0 Safari/537.36',
      'Chromium 119.0.0.0',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0',
      'Firefox 119.0',
    ],
    [
      'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      'Safari 17.1',
    ],
    ['Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko', 'Internet Explorer 11.0'],
    ['Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)', 'Internet Explorer 6.0'],
    ['Opera/9.80 (Windows NT 6.1) Presto/2.12.388 Version/12.18', 'Opera 12.18'],
    ['Opera/9.64 (X11; Linux i686; U; en) Presto/2.1.1', 'Opera 9.64'],
    [
      'Opera/9.80 (Android; Opera Mini/7.5.33361/31.1543; U; en) Presto/2.8.119 Version/11.1010',
      'Opera Mini 7.5.33361',
    ],
    [
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 EdgA/119.0.0.0',
      'Edge 119.0.0.0',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'iOS WebView',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1',
      undefined,
    ],
    ['', undefined],
    ['something else entirely', undefined],
  ])('%s', (ua, expected) => {
    expect(browser(ua)).toBe(expected);
  });

  it('puts crawlers and tools before the browser they pretend to be', () => {
    expect(
      browser(`Mozilla/5.0 (Linux; Android 6.0.1) ${CHROME} (compatible; Googlebot/2.1)`),
    ).toBe('Googlebot 2.1');
    expect(
      browser(`Mozilla/5.0 (compatible; MyOwnCrawler/3.2; +https://bot.example/) ${CHROME}`),
    ).toBe('MyOwnCrawler 3.2');
    expect(browser('Mozilla/5.0 (compatible; Foo-spider)')).toBe('Foo-spider');
    expect(browser('curl/7.88.1')).toBe('curl 7.88.1');
  });

  it.each([
    ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'Googlebot'],
    ['AdsBot-Google (+https://bot.example/)', undefined],
    ['Mozilla/5.0 (compatible; AdsBot-Google/1.0)', 'Googlebot'],
    ['Mozilla/5.0 (compatible; Google-InspectionTool/1.0)', 'Google-InspectionTool'],
    ['Mozilla/5.0 (compatible; bingbot/2.0)', 'Bingbot'],
    ['Mozilla/5.0 (compatible; DuckDuckBot/1.1)', 'DuckDuckBot'],
    ['Mozilla/5.0 (compatible; YandexBot/3.0)', 'YandexBot'],
    ['Mozilla/5.0 (compatible; Twitterbot/1.0)', 'Twitterbot'],
    ['LinkedInBot/1.0 (compatible)', 'LinkedInBot'],
    ['Mozilla/5.0 (compatible; Applebot/0.1)', 'Applebot'],
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0)', 'ClaudeBot'],
    ['Mozilla/5.0 (compatible; CCBot/2.0)', 'CCBot'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0)', 'PerplexityBot'],
    ['Mozilla/5.0 (compatible; SemrushBot/7)', 'SemrushBot'],
    ['Mozilla/5.0 (compatible; Bytespider)', 'Bytespider'],
    ['Mozilla/5.0 (compatible; PetalBot)', 'PetalBot'],
    ['Mozilla/5.0 (compatible; UptimeRobot/2.0)', 'UptimeRobot'],
    ['Mozilla/5.0 (compatible; Discordbot/2.0)', 'Discordbot'],
    ['Mozilla/5.0 (compatible; Googlebot)', 'Googlebot'],
  ])('knows the crawler in %s', (ua, name) => {
    const info = parseUserAgent(ua);
    if (name === undefined) {
      return;
    }
    expect(info.browser?.name).toBe(name);
    expect(info.device.type).toBe('bot');
  });

  it.each([
    ['curl/8.0.1', 'curl'],
    ['Wget/1.21', 'Wget'],
    ['HTTPie/3.2.2', 'HTTPie'],
    ['python-requests/2.31.0', 'python-requests'],
    ['Python-urllib/3.11', 'Python urllib'],
    ['Python/3.11 aiohttp/3.9.1', 'aiohttp'],
    ['Go-http-client/1.1', 'Go http client'],
    ['node-fetch/1.0', 'node-fetch'],
    ['axios/1.6.2', 'axios'],
    ['okhttp/4.12.0', 'okhttp'],
    ['Apache-HttpClient/4.5.14 (Java/17)', 'Apache HttpClient'],
    ['Java/1.8.0_392', 'Java'],
    ['libwww-perl/6.72', 'libwww-perl'],
    ['PostmanRuntime/7.36.0', 'PostmanRuntime'],
    ['insomnia/8.4.5', 'Insomnia'],
    ['Dart/3.2 (dart:io)', 'Dart'],
    ['Lynx/2.9.0', 'Lynx'],
  ])('knows the tool in %s', (ua, name) => {
    const info = parseUserAgent(ua);
    expect(info.browser?.name).toBe(name);
    expect(info.device.type).toBe('library');
    expect(info.os).toBeUndefined();
    expect(info.engine).toBeUndefined();
  });

  it('reads a crawler without a version', () => {
    expect(parseUserAgent('Mozilla/5.0 (compatible; Yahoo! Slurp)').browser).toEqual({
      name: 'Yahoo! Slurp',
      version: undefined,
    });
  });
});

describe('engines', () => {
  const engine = (ua: string): string | undefined => {
    const found = parseUserAgent(ua).engine;
    return found === undefined ? undefined : `${found.name} ${found.version ?? ''}`.trim();
  };

  it.each([
    [`Mozilla/5.0 (Windows NT 10.0) ${CHROME}`, 'Blink 119.0.0.0'],
    ['Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0', 'Gecko 120.0'],
    ['Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/120.0', 'Gecko 120.0'],
    [
      'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      'WebKit 605.1.15',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.169 Mobile/15E148 Safari/604.1',
      'WebKit 605.1.15',
    ],
    ['Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko', 'Trident 7.0'],
    [
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/70.0 Safari/537.36 Edge/18.19041',
      'EdgeHTML 18.19041',
    ],
    ['Opera/9.80 (Windows NT 6.1) Presto/2.12.388 Version/12.18', 'Presto 2.12.388'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko)', 'WebKit 537.36'],
    ['curl/8.0', undefined],
    ['', undefined],
  ])('%s', (ua, expected) => {
    expect(engine(ua)).toBe(expected);
  });

  it('does not take "like Gecko" for the Gecko engine', () => {
    expect(engine(`Mozilla/5.0 (X11; Linux) ${CHROME}`)).toBe('Blink 119.0.0.0');
  });

  it('takes the Firefox version for Gecko when the string has no rv', () => {
    expect(engine('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/118.0')).toBe(
      'Gecko 118.0',
    );
  });
});

describe('operating systems', () => {
  const os = (ua: string): string | undefined => {
    const found = parseUserAgent(ua).os;
    return found === undefined ? undefined : `${found.name} ${found.version ?? ''}`.trim();
  };

  it.each([
    ['(Windows NT 10.0; Win64; x64)', 'Windows 10 or 11'],
    ['(Windows NT 6.3; Win64; x64)', 'Windows 8.1'],
    ['(Windows NT 6.2)', 'Windows 8'],
    ['(Windows NT 6.1)', 'Windows 7'],
    ['(Windows NT 6.0)', 'Windows Vista'],
    ['(Windows NT 5.2)', 'Windows XP x64'],
    ['(Windows NT 5.1)', 'Windows XP'],
    ['(Windows NT 5.0)', 'Windows 2000'],
    ['(Windows NT 6.4)', 'Windows 10'],
    ['(Windows NT 11.5)', 'Windows 11.5'],
    ['(Windows 98; Win 9x 4.90)', 'Windows 98'],
    ['(Win98)', 'Windows 98'],
    ['(Windows Phone 10.0; Android 6.0.1)', 'Windows Phone 10.0'],
    ['(Windows Phone OS 7.5; Trident/5.0)', 'Windows Phone 7.5'],
    ['(Linux; Android 14; Pixel 8)', 'Android 14'],
    ['(Linux; Android; Pixel)', 'Android'],
    ['(Linux; HarmonyOS; ELS-N29)', 'HarmonyOS'],
    ['(Linux; OpenHarmony 4.0)', 'HarmonyOS 4.0'],
    ['(Mobile; KaiOS/3.0; rv:84.0) Gecko/84.0 Firefox/84.0 KAIOS/3.0', 'KaiOS 3.0'],
    ['(iPhone; CPU iPhone OS 16_6_1 like Mac OS X)', 'iOS 16.6.1'],
    ['(iPad; CPU OS 13_1 like Mac OS X)', 'iPadOS 13.1'],
    ['(iPad; CPU OS 12_5 like Mac OS X)', 'iOS 12.5'],
    ['(iPod touch; CPU iPhone OS 12_0 like Mac OS X)', 'iOS 12.0'],
    ['(iPad)', 'iOS'],
    ['(X11; CrOS x86_64 14541.0.0)', 'ChromeOS 14541.0.0'],
    ['(X11; CrOS)', 'ChromeOS'],
    ['(Macintosh; Intel Mac OS X 14_1)', 'macOS 14.1'],
    ['(Macintosh; Intel Mac OS X 10.9.5)', 'macOS 10.9.5'],
    ['(Macintosh; PPC)', 'macOS'],
    ['(SMART-TV; Linux; Tizen 7.0)', 'Tizen 7.0'],
    ['(Web0S; Linux/SmartTV)', 'webOS'],
    ['(webOS.TV-2020)', 'webOS'],
    ['(PlayStation; PlayStation 5/2.26)', 'PlayStation 5'],
    ['(PlayStation 4 11.00)', 'PlayStation 4'],
    ['(PlayStation Vita 3.74)', 'PlayStation Vita'],
    ['(Xbox; Xbox One)', 'Xbox'],
    ['(Nintendo Switch; WifiWebAuthApplet)', 'Nintendo Switch'],
    ['(Nintendo 3DS)', 'Nintendo 3DS'],
    ['(Nintendo WiiU) AppleWebKit', 'Nintendo WiiU'],
    ['(X11; Ubuntu; Linux x86_64)', 'Ubuntu'],
    ['(X11; Ubuntu/22.04; Linux)', 'Ubuntu 22.04'],
    ['(X11; Fedora; Linux x86_64)', 'Fedora'],
    ['(X11; Debian; Linux x86_64)', 'Debian'],
    ['(X11; openSUSE; Linux)', 'openSUSE'],
    ['(X11; CentOS; Linux)', 'CentOS'],
    ['(X11; Red Hat; Linux)', 'Red Hat'],
    ['(X11; Mint; Linux)', 'Linux Mint'],
    ['(X11; Gentoo; Linux)', 'Gentoo'],
    ['(X11; FreeBSD amd64)', 'FreeBSD'],
    ['(X11; OpenBSD amd64)', 'OpenBSD'],
    ['(X11; NetBSD amd64)', 'NetBSD'],
    ['(X11; Linux x86_64)', 'Linux'],
    ['(X11; SunOS i86pc)', 'Linux'],
    ['curl/8.0', undefined],
    ['', undefined],
  ])('%s', (text, expected) => {
    expect(os(`Mozilla/5.0 ${text}`)).toBe(expected);
  });
});

describe('devices', () => {
  const device = (ua: string): UserAgentInfo['device'] => parseUserAgent(ua).device;

  it('tells phones from tablets on Android by the word "Mobile"', () => {
    expect(
      device(
        `Mozilla/5.0 (Linux; Android 13; Pixel 7) ${CHROME}`.replace('Safari', 'Mobile Safari'),
      ).type,
    ).toBe('mobile');
    expect(device(`Mozilla/5.0 (Linux; Android 13; Pixel Tablet) ${CHROME}`).type).toBe('tablet');
  });

  it('reads the model after the Android version, with or without a locale or a build', () => {
    expect(device('Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) Mobile').model).toBe('Pixel 7 Pro');
    expect(
      device('Mozilla/5.0 (Linux; U; Android 4.4.2; en-us; GT-I9505 Build/KOT49H) Mobile').model,
    ).toBe('GT-I9505');
    expect(
      device('Mozilla/5.0 (Linux; U; Android 2.3.6; de_DE; GT-S5830 Build/GINGERBREAD) Mobile')
        .model,
    ).toBe('GT-S5830');
    expect(device('Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A; wv) Mobile').model).toBe(
      'SM-G991B',
    );
    expect(device('Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) Mobile').model).toBe(
      'SM-S918B',
    );
    expect(
      device('Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0').model,
    ).toBeUndefined();
    expect(device('Mozilla/5.0 (Android 14; Tablet; rv:120.0) Gecko/120.0 Firefox/120.0')).toEqual({
      type: 'tablet',
      vendor: undefined,
      model: undefined,
    });
    expect(device('Mozilla/5.0 (Linux; Android 13) Mobile').model).toBeUndefined();
    expect(device('Mozilla/5.0 (Linux; Android 13;) Mobile').model).toBeUndefined();
    expect(device('Mozilla/5.0 (Linux; Android 13; Build/X) Mobile').model).toBeUndefined();
    expect(device('Mozilla/5.0 (Linux; Android 13; Pixel 7').model).toBe('Pixel 7');
  });

  it.each([
    ['SM-G991B', 'Samsung'],
    ['GT-I9505', 'Samsung'],
    ['Pixel 8', 'Google'],
    ['Nexus 5X', 'Google'],
    ['Redmi Note 12', 'Xiaomi'],
    ['POCO F5', 'Xiaomi'],
    ['M2007J20CG', 'Xiaomi'],
    ['HUAWEI P30', 'Huawei'],
    ['HONOR 90', 'Honor'],
    ['OnePlus 11', 'OnePlus'],
    ['moto g(30)', 'Motorola'],
    ['XT2201', 'Motorola'],
    ['Nokia G21', 'Nokia'],
    ['Xperia 1 V', 'Sony'],
    ['LM-G900', 'LG'],
    ['CPH2451', 'OPPO'],
    ['vivo 1901', 'vivo'],
    ['RMX3511', 'realme'],
    ['ASUS_I006D', 'ASUS'],
    ['Lenovo TB-X606F', 'Lenovo'],
    ['Fairphone 5', 'Fairphone'],
    ['KFTRWI', 'Amazon'],
  ])('knows the maker of the model %s', (model, vendor) => {
    expect(device(`Mozilla/5.0 (Linux; Android 13; ${model}) Mobile`)).toMatchObject({
      vendor,
      model,
    });
  });

  it('leaves the maker out when the model is not known', () => {
    expect(device('Mozilla/5.0 (Linux; Android 13; Foo 3000) Mobile')).toEqual({
      type: 'mobile',
      vendor: undefined,
      model: 'Foo 3000',
    });
  });

  it('knows Apple devices', () => {
    expect(device('Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X)')).toEqual({
      type: 'mobile',
      vendor: 'Apple',
      model: 'iPhone',
    });
    expect(device('Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X)')).toEqual({
      type: 'tablet',
      vendor: 'Apple',
      model: 'iPad',
    });
    expect(device('Mozilla/5.0 (iPod touch; CPU iPhone OS 12_0 like Mac OS X)')).toEqual({
      type: 'mobile',
      vendor: 'Apple',
      model: 'iPod touch',
    });
    expect(device('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1)')).toEqual({
      type: 'desktop',
      vendor: 'Apple',
      model: 'Mac',
    });
  });

  it('knows consoles, televisions and wearables', () => {
    expect(device('Mozilla/5.0 (PlayStation 4 11.00)').vendor).toBe('Sony');
    expect(device('Mozilla/5.0 (Windows NT 10.0; Xbox; Xbox One)')).toEqual({
      type: 'console',
      vendor: 'Microsoft',
      model: undefined,
    });
    expect(device('Mozilla/5.0 (Nintendo Switch)').vendor).toBe('Nintendo');
    expect(device('Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0)')).toEqual({
      type: 'tv',
      vendor: 'Samsung',
      model: undefined,
    });
    expect(device('Mozilla/5.0 (Web0S; Linux/SmartTV)')).toEqual({
      type: 'tv',
      vendor: 'LG',
      model: undefined,
    });
    expect(device('Roku/DVP-9.10 (519.10E04111A)').type).toBe('tv');
    expect(device('Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) Mobile').vendor).toBe(
      'Amazon',
    );
    expect(device('Mozilla/5.0 (X11; Linux armv7l) CrKey/1.56').type).toBe('tv');
    expect(device('Mozilla/5.0 (Linux; Android 7.1.1; Wear OS 3) Mobile')).toEqual({
      type: 'wearable',
      vendor: undefined,
      model: undefined,
    });
    expect(device('Mozilla/5.0 (Apple Watch; watchOS 10.1)').type).toBe('wearable');
  });

  it('calls a Windows phone and a KaiOS phone a phone, and any "Mobile" string a phone', () => {
    expect(
      device('Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950)').type,
    ).toBe('mobile');
    expect(device('Mozilla/5.0 (Mobile; KaiOS/3.0)').type).toBe('mobile');
    expect(device('Mozilla/5.0 (Unknown; Mobile)').type).toBe('mobile');
  });

  it('calls Windows, Chrome OS and Linux machines computers, and says "unknown" otherwise', () => {
    expect(device('Mozilla/5.0 (Windows NT 10.0)').type).toBe('desktop');
    expect(device('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)').type).toBe('desktop');
    expect(device('Mozilla/5.0 (X11; Linux x86_64)').type).toBe('desktop');
    expect(device('Mozilla/5.0 (X11; FreeBSD amd64)').type).toBe('desktop');
    expect(device('Mozilla/5.0 (Unknown)').type).toBe('unknown');
    expect(device('').type).toBe('unknown');
  });

  it('calls a Silk browser without "Mobile" a tablet', () => {
    expect(device('Mozilla/5.0 (X11; Linux) Silk/116.5.1 like Chrome/116.0.0.0').type).toBe(
      'tablet',
    );
  });

  it('shows a crawler as a crawler, whatever device it imitates', () => {
    const info = parseUserAgent(
      `Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) ${CHROME} Mobile (compatible; Googlebot/2.1)`,
    );
    expect(info.device.type).toBe('bot');
    expect(info.device.model).toBe('Nexus 5X');
  });
});

describe('CPU architecture', () => {
  const cpu = (ua: string): string | undefined => parseUserAgent(ua).cpu;

  it.each([
    ['(X11; Linux x86_64)', 'x86-64'],
    ['(Windows NT 10.0; Win64; x64)', 'x86-64'],
    ['(Windows NT 10.0; WOW64)', 'x86-64'],
    ['(X11; Linux amd64)', 'x86-64'],
    ['(X11; FreeBSD amd64)', 'x86-64'],
    ['(X11; Linux aarch64)', 'ARM64'],
    ['(Windows NT 10.0; ARM64)', 'ARM64'],
    ['(X11; Linux armv7l)', 'ARM'],
    ['(X11; Linux armv8l)', 'ARM'],
    ['(Windows NT 10.0; ARM; Trident/7.0)', 'ARM'],
    ['(X11; Linux i686)', 'x86'],
    ['(X11; Linux i386)', 'x86'],
    ['(Macintosh; Intel Mac OS X 10_15_7)', undefined],
    ['(iPhone; CPU iPhone OS 17_1 like Mac OS X)', undefined],
  ])('%s', (text, expected) => {
    expect(cpu(`Mozilla/5.0 ${text}`)).toBe(expected);
  });

  it('takes ARM64 over an x64 that is only the emulation layer', () => {
    expect(cpu('Mozilla/5.0 (Windows NT 10.0; ARM64; Win64; x64)')).toBe('ARM64');
  });
});

describe('notes', () => {
  it('says that Windows 10 and 11 look alike', () => {
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)').notes).toEqual([
      'windows-10-11',
    ]);
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 6.1)').notes).toEqual([]);
  });

  it('says that the macOS version is frozen at 10.15.7, and only then', () => {
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)').notes).toEqual([
      'frozen-macos',
    ]);
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6)').notes).toEqual([]);
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1)').notes).toEqual([]);
  });

  it('says that the device model is hidden by the reduced user agent ("K"), and only then', () => {
    const reduced = parseUserAgent(`Mozilla/5.0 (Linux; Android 10; K) ${CHROME} Mobile`);
    expect(reduced.notes).toEqual(['reduced-device']);
    expect(reduced.device.model).toBeUndefined();
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 10; KB2000) Mobile').notes).toEqual([]);
  });

  it('has no note for a string that needs none', () => {
    expect(parseUserAgent('curl/8.0').notes).toEqual([]);
  });
});

describe('limits and hostile input', () => {
  it('ignores white space around the string', () => {
    expect(parseUserAgent('  \n curl/8.0 \t')).toEqual(parseUserAgent('curl/8.0'));
  });

  it('looks only at the first part of a very long string', () => {
    const long = `curl/8.0 ${'x'.repeat(MAX_USER_AGENT_LENGTH)} Firefox/1.0`;
    expect(parseUserAgent(long).browser?.name).toBe('curl');
    const hidden = `${'x'.repeat(MAX_USER_AGENT_LENGTH)} Firefox/1.0`;
    expect(parseUserAgent(hidden).browser).toBeUndefined();
    const edge = `${'x'.repeat(MAX_USER_AGENT_LENGTH - 12)} Firefox/1.0`;
    expect(parseUserAgent(edge).browser?.name).toBe('Firefox');
  });

  it('answers quickly for strings built to make a pattern backtrack', () => {
    const started = performance.now();
    for (const ua of [
      `Mozilla/5.0 (${'Linux; '.repeat(250)}`,
      `Opera/9 ${'Version/'.repeat(200)}`,
      `Mozilla/5.0 (Windows NT 10.0; Trident/7.0; ${'rv:'.repeat(300)}`,
      `Mozilla/5.0 ${'Android 1; '.repeat(150)}`,
      `${'a'.repeat(1999)}bot`,
      `; wv) ${'Chrome '.repeat(250)}`,
      'Version/1 '.repeat(190),
    ]) {
      parseUserAgent(ua);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('never throws, and always answers with a complete result (seeded random text)', () => {
    let state = 1_119;
    const random = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const words = [
      'Mozilla/5.0',
      '(',
      ')',
      ';',
      'Windows NT 10.0',
      'Android 13',
      'iPhone',
      'Mobile',
      'Chrome/119.0',
      'Safari/537.36',
      'Firefox/1.0',
      'Linux',
      'rv:1.0',
      'Build/X',
      'wv',
      'Edg/1',
      'bot',
      '/',
      '\u0000',
      'é',
      ' ',
    ];
    for (let round = 0; round < 2000; round += 1) {
      let ua = '';
      for (let at = 0, n = Math.floor(random() * 20); at < n; at += 1) {
        ua += `${words[Math.floor(random() * words.length)] ?? ''} `;
      }
      const info = parseUserAgent(ua);
      expect(info.device.type, ua).toBeTypeOf('string');
      expect(info.notes, ua).toBeInstanceOf(Array);
      expect(parseUserAgent(ua), ua).toEqual(info);
    }
  });
});
