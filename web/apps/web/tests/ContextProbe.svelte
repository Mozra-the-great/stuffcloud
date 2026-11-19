<script lang="ts">
  import { getTools } from '../src/app/context.ts';

  const tools = getTools();
</script>

<p>{tools.length}</p>
