<script lang="ts">
  import {
    Button,
    Card,
    CodeBlock,
    FileDrop,
    Mascot,
    MASCOT_NAMES,
    Modal,
    Progress,
    TabLinks,
    Tabs,
    Tile,
    TileGrid,
    toast,
    Toaster,
    type TabItem,
    type TabLinkItem,
    type ToastTone,
  } from '@mozra-the-great/kern';
  import '../styles/index.css';
  import Checkbox from '../ui/Checkbox.svelte';
  import Input from '../ui/Input.svelte';
  import Select from '../ui/Select.svelte';
  import type { SelectOption } from '../ui/types.ts';
  import { GALLERY_COLOURS, GALLERY_FONTS } from './swatches.ts';
  import { MASCOT_URLS } from '../app/mascots.ts';

  const selectOptions: readonly SelectOption[] = [
    { value: 'one', label: 'One day' },
    { value: 'seven', label: 'Seven days' },
    { value: 'never', label: 'Never', disabled: true },
  ];
  const tabs: readonly TabItem[] = [
    { id: 'json', label: 'JSON' },
    { id: 'yaml', label: 'YAML' },
    { id: 'xml', label: 'XML' },
  ];
  const tabLinks: readonly TabLinkItem[] = [
    { href: '#convert', label: 'Convert', current: true },
    { href: '#base64', label: 'Base64' },
    { href: '#colours', label: 'Colours' },
  ];
  // Named by what the app calls them; kern's tones behind them.
  const toastKinds: readonly { readonly name: string; readonly tone: ToastTone }[] = [
    { name: 'info', tone: 'info' },
    { name: 'success', tone: 'ok' },
    { name: 'warn', tone: 'warn' },
    { name: 'error', tone: 'danger' },
  ];

  let text = $state('stuffcloud');
  let duration = $state('seven');
  let accepted = $state(true);
  let tab = $state('json');
  let dialogOpen = $state(false);
  let dropped = $state('');
</script>

<main class="gallery">
  <h1 class="title">Components</h1>

  <section aria-labelledby="g-tokens">
    <h2 class="label" id="g-tokens">Tokens</h2>
    <ul class="swatches">
      {#each GALLERY_COLOURS as colour (colour)}
        <li>
          <span class="swatch" style:background={`var(${colour})`}></span>
          <code>{colour}</code>
        </li>
      {/each}
    </ul>
    <ul class="fonts">
      {#each GALLERY_FONTS as font (font.token)}
        <li style:font-family={`var(${font.token})`}>{font.sample}<code>{font.token}</code></li>
      {/each}
    </ul>
  </section>

  <section aria-labelledby="g-mascot">
    <h2 class="label" id="g-mascot">Mascot</h2>
    <div class="stage">
      <Mascot name="stuffy" src={MASCOT_URLS.stuffy} scale={16} compactScale={9} />
    </div>
    <ul class="cast">
      {#each MASCOT_NAMES as name (name)}
        <li>
          <Mascot {name} src={MASCOT_URLS[name]} scale={6} />
          <code>{name}</code>
        </li>
      {/each}
      <li>
        <Mascot name="stuffy" src={MASCOT_URLS.stuffy} scale={6} animated={false} />
        <code>still</code>
      </li>
    </ul>
  </section>

  <section aria-labelledby="g-buttons">
    <h2 class="label" id="g-buttons">Button, link button</h2>
    <div class="row">
      <Button>Primary</Button>
      <Button variant="secondary">Ghost</Button>
      <Button variant="danger">Danger</Button>
      <Button disabled>Disabled</Button>
      <Button size="sm">Compact</Button>
      <Button size="icon" variant="secondary" aria-label="Menu">
        <svg
          width="20"
          height="14"
          viewBox="0 0 20 14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M0 1h20M0 7h20M0 13h20" />
        </svg>
      </Button>
    </div>
    <div class="row">
      <Button href="#buttons">Link button</Button>
      <Button href="#buttons" variant="secondary">Ghost link</Button>
    </div>
    <div class="wide">
      <Button wide>
        <span>Wide</span>
        <span aria-hidden="true">&rarr;</span>
      </Button>
    </div>
  </section>

  <section aria-labelledby="g-fields">
    <h2 class="label" id="g-fields">Input, select, checkbox</h2>
    <div class="stack">
      <Input label="Name" bind:value={text} hint="Letters and digits" />
      <Input
        label="Subdomain"
        value="Bad Name"
        error="Lowercase letters, digits and hyphens only"
      />
      <Input label="Locked" value="read only" disabled />
      <Select label="Expires" options={selectOptions} bind:value={duration} />
      <Checkbox label="Protect with a password" bind:checked={accepted} />
      <Checkbox label="Disabled option" disabled />
    </div>
  </section>

  <section aria-labelledby="g-tabs">
    <h2 class="label" id="g-tabs">Tabs</h2>
    <Tabs {tabs} label="Formats" bind:value={tab}>
      {#snippet panel(id: string)}
        <p class="panel">{tabs.find((item) => item.id === id)?.label}</p>
      {/snippet}
    </Tabs>
    <TabLinks links={tabLinks} label="Convert tools" />
  </section>

  <section aria-labelledby="g-cards">
    <h2 class="label" id="g-cards">Card, tile</h2>
    <Card as="div">
      <span class="label">Card</span>
      <span>Content</span>
    </Card>
    <TileGrid>
      <Tile href="#tile"><span>Linked tile</span></Tile>
      <Tile><span>Plain tile</span></Tile>
    </TileGrid>
  </section>

  <section aria-labelledby="g-dialog">
    <h2 class="label" id="g-dialog">Dialog</h2>
    <div class="row">
      <Button
        variant="secondary"
        onclick={() => {
          dialogOpen = true;
        }}
      >
        Open dialog
      </Button>
    </div>
    <Modal bind:open={dialogOpen} title="Delete site" closeLabel="Close">
      <p class="panel">my-site.example</p>
      {#snippet footer()}
        <Button
          variant="secondary"
          onclick={() => {
            dialogOpen = false;
          }}
        >
          Cancel
        </Button>
        <Button variant="danger">Delete</Button>
      {/snippet}
    </Modal>
  </section>

  <section aria-labelledby="g-toast">
    <h2 class="label" id="g-toast">Toast</h2>
    <div class="row">
      {#each toastKinds as kind (kind.name)}
        <Button
          variant="secondary"
          size="sm"
          onclick={() => {
            toast({ message: `A ${kind.name} message`, tone: kind.tone });
          }}
        >
          {kind.name}
        </Button>
      {/each}
    </div>
  </section>

  <section aria-labelledby="g-progress">
    <h2 class="label" id="g-progress">Progress</h2>
    <div class="stack">
      <Progress hideLabel label="Upload" value={40} />
      <Progress hideLabel label="Storage" value={100} tone="warn" />
      <Progress hideLabel label="Working" />
    </div>
  </section>

  <section aria-labelledby="g-code">
    <h2 class="label" id="g-code">Code block</h2>
    <CodeBlock
      label="Deploy command"
      code="stuffcloud deploy ./dist --expires 7d"
      copyLabel="Copy"
      copiedLabel="Copied"
    />
  </section>

  <section aria-labelledby="g-drop">
    <h2 class="label" id="g-drop">File dropzone</h2>
    <FileDrop
      mode="dispatch"
      multiple
      rejectMessages={false}
      statusLabel=""
      dropLabel="drop PDFs here"
      buttonLabel="Choose files"
      accept=".pdf,application/pdf"
      onfiles={(files: File[]) => {
        dropped = files.map((file) => file.name).join(', ');
      }}
    />
    <p class="mono" aria-live="polite">{dropped}</p>
  </section>
</main>

<Toaster position="bottom-left" label="Notifications" dismissLabel="Dismiss" />

<style>
  .gallery {
    display: flex;
    flex-direction: column;
    gap: var(--space-40);
    max-width: 860px;
    margin: 0 auto;
    padding: var(--space-40) var(--space-16);
  }

  .title {
    margin: 0;
    font: 400 28px var(--pix);
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
  }

  .label {
    margin: 0;
    font: 12px var(--mono);
    letter-spacing: 1px;
    color: var(--mut);
    text-transform: uppercase;
    font-weight: 400;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-10);
    align-items: center;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-20);
  }

  .wide {
    max-width: 320px;
  }

  .panel {
    margin: 0;
    padding: var(--space-16);
    font: 14px var(--mono);
  }

  .mono {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
    min-height: 1em;
  }

  .swatches,
  .fonts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .swatches li {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    font: 12px var(--mono);
    color: var(--mut);
  }

  .swatch {
    display: block;
    width: 96px;
    height: 48px;
    border: 1px solid var(--line2);
  }

  .stage {
    display: flex;
    justify-content: center;
    align-items: flex-end;
    min-height: 220px;
    padding-top: var(--space-16);
    overflow: hidden;
    background: var(--violet);
  }

  .cast {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-24);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .cast li {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-8);
    font: 12px var(--mono);
    color: var(--mut);
  }

  .fonts {
    flex-direction: column;
  }

  .fonts li {
    display: flex;
    align-items: baseline;
    gap: var(--space-16);
    font-size: 20px;
  }

  .fonts code {
    font: 12px var(--mono);
    color: var(--mut);
  }
</style>
