<script lang="ts">
  import { brokenState } from './broken-state.ts';

  if (brokenState.broken) {
    throw new TypeError('page failed to render');
  }
</script>

<h1>Fixed page</h1>
