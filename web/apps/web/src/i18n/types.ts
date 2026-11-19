/** CLDR plural categories (`Intl.PluralRules`); a locale uses the subset it needs. */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** One text per plural category; `other` is the fallback and always present. */
export type PluralMessage = { readonly other: string } & Readonly<
  Partial<Record<Exclude<PluralCategory, 'other'>, string>>
>;

/** A message is plain text or plural forms. `{name}` marks a placeholder. */
export type Message = string | PluralMessage;

export type Catalog = Readonly<Record<string, Message>>;

/** Values for placeholders. Plural messages read the number from `count`. */
export type MessageParams = Readonly<Record<string, string | number>>;
