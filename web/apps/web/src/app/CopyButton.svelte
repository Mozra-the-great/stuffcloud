<script lang="ts">
  import { t } from '../i18n/index.ts';
  import Button from '../ui/Button.svelte';
  import { toaster } from '../ui/toast.svelte.ts';
  import { copyText } from './clipboard.ts';

  interface Props {
    /** What is put on the clipboard. */
    text: string;
    /** Accessible name; it contains the visible word, for example "Copy HEX". */
    label: string;
    /** The text of the confirmation; defaults to the copied text. */
    value?: string;
  }

  let { text, label, value }: Props = $props();

  async function copy(): Promise<void> {
    if (await copyText(text)) {
      toaster.push(t('tool.copied', { value: value ?? text }), { kind: 'success' });
    } else {
      toaster.push(t('tool.copyFailed'), { kind: 'warn' });
    }
  }
</script>

<!--
  Candidate for kern (#121): a copy button whose result is announced (kern issue #72; #46 covers the
  one inside a code block). Here it reports through the app's toast region (role="status"), once
  per click, for a failure as well as a success.
-->
<Button variant="ghost" size="compact" aria-label={label} onclick={copy}>{t('tool.copy')}</Button>
