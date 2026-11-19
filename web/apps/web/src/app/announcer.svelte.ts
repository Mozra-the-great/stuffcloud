/**
 * Text for the polite live region (`LiveAnnouncer`): a navigation does not reload the page, so
 * screen readers hear the new page's title from here.
 * Candidate for kern (#121).
 */
export class Announcer {
  #message = $state('');

  get message(): string {
    return this.#message;
  }

  announce(message: string): void {
    this.#message = message;
  }
}
