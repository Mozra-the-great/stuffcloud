export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface TabItem {
  readonly id: string;
  readonly label: string;
}

export interface TabLink {
  readonly href: string;
  readonly label: string;
  /** The link of the page the visitor is on. */
  readonly current?: boolean;
}
