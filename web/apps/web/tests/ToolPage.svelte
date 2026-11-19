<script lang="ts">
  // Tool routes are literal paths (`/tools/<id>`): the id is the last segment.
  const id = window.location.pathname.split('/').at(-1) ?? '';
</script>

<h1>Tool {id}</h1>
