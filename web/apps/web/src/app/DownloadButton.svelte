<script lang="ts">
  import { DownloadButton } from '@mozra-the-great/kern';
  import { t } from '../i18n/index.ts';

  interface Props {
    /** Visible text and accessible name, for example "Download .json". */
    label: string;
    /** File name offered to the browser (kern cleans it). */
    name: string;
    /** UTF-8 text to save. A `blob` wins over it. */
    text?: string;
    /** Bytes to save. */
    blob?: Blob;
    /** Makes the content at click time (a big file is not copied before it is asked for); wins over `blob` and `text`. */
    getContent?: () => string | Blob;
    /** MIME type; for text kern adds `;charset=utf-8`. */
    type?: string;
    disabled?: boolean;
  }

  let { label, name, text, blob, getContent, type, disabled = false }: Props = $props();
</script>

<!--
  kern's DownloadButton with the app's texts. The file is made in this browser and handed to it as an
  object URL; nothing is sent anywhere (ADR 0014, privacy rules of the tools).
-->
<DownloadButton
  {label}
  {name}
  {text}
  {blob}
  {getContent}
  {type}
  {disabled}
  showLabel
  variant="secondary"
  size="sm"
  startedLabel={t('tool.downloadStarted')}
  errorLabel={t('tool.downloadFailed')}
/>
