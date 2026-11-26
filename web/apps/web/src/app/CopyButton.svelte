<script lang="ts">
  import { CopyButton, toast } from '@mozra-the-great/kern';
  import { t } from '../i18n/index.ts';

  interface Props {
    /** What is put on the clipboard. */
    text: string;
    /** Accessible name and tooltip of the icon button, for example "Copy HEX". */
    label: string;
    /** The text of the confirmation; defaults to the copied text. */
    value?: string;
  }

  let { text, label, value }: Props = $props();
</script>

<!--
  kern's CopyButton with the app's texts. The result is said by the toast region (once per click,
  for a failure as well as a success; it is also the visible confirmation), so kern's own spoken
  messages are switched off with '' instead of saying everything twice.
-->
<CopyButton
  {text}
  {label}
  variant="secondary"
  size="sm"
  copiedLabel=""
  errorLabel=""
  oncopy={() => {
    toast.ok(t('tool.copied', { value: value ?? text }));
  }}
  onerror={() => {
    toast.warn(t('tool.copyFailed'));
  }}
/>
