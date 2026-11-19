<script lang="ts">
  interface Props {
    /** Id of the element to jump to; it must be focusable (`tabindex="-1"`). */
    target: string;
    label: string;
  }

  let { target, label }: Props = $props();

  // The router keeps the address bar as it is: move focus instead of changing the fragment.
  function jump(event: MouseEvent): void {
    const element = document.getElementById(target);
    if (element !== null) {
      event.preventDefault();
      element.focus();
    }
  }
</script>

<!-- Candidate for kern (#121): a generic skip link. -->
<a class="skip" href={`#${target}`} onclick={jump}>{label}</a>

<style>
  .skip {
    position: absolute;
    left: var(--space-8);
    top: var(--space-8);
    z-index: 100;
    padding: var(--space-12) var(--space-16);
    background: var(--fg);
    color: var(--bg);
    font: 600 15px var(--sans);
    transform: translateY(-200%);
  }

  .skip:focus {
    transform: none;
  }
</style>
