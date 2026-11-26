<script lang="ts">
  import { Button, toast } from '@mozra-the-great/kern';
  import { t } from '../i18n/index.ts';
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
      toast.ok(t('tool.copied', { value: value ?? text }));
    } else {
      toast.warn(t('tool.copyFailed'));
    }
  }
</script>

<!--
  Candidate for kern (#121): a copy button whose result is announced (kern issue #72; #46 covers the
  one inside a code block). Here it reports through the app's toast region (kern's Toaster) (role="status"), once
  per click, for a failure as well as a success.
-->
<Button variant="secondary" size="sm" aria-label={label} onclick={copy}>{t('tool.copy')}</Button>
