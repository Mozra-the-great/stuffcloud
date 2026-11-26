<script lang="ts">
  import { CopyButton, toast } from '@mozra-the-great/kern';
  import { t } from '../i18n/index.ts';

  interface Props {
    /** What is put on the clipboard. */
    text: string;
    /** Accessible name of the button; it contains the visible word, for example "Copy HEX". */
    label: string;
    /** The text of the confirmation; defaults to the copied text. */
    value?: string;
  }

  let { text, label, value }: Props = $props();
</script>

<!--
  kern's CopyButton with the app's texts: the short word "Copy" on the button (the design), the tool's
  longer label as its accessible name (kern#166; WCAG 2.5.3, the name contains the visible word, which
  a test over both catalogues checks). The result is said by the toast region (once per click,
  for a failure as well as a success; it is also the visible confirmation), so kern's own spoken
  messages are switched off with '' instead of saying everything twice.
-->
<CopyButton
  {text}
  label={t('tool.copy')}
  accessibleLabel={label}
  showLabel
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
