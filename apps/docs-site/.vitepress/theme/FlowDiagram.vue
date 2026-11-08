<script setup>
defineProps({
  label: { type: String, required: true },
  steps: { type: Array, required: true },
});
</script>

<template>
  <ol class="flow" :aria-label="label">
    <li v-for="step in steps" :key="step.label" :class="{ gate: step.gate }">
      <strong>{{ step.label }}</strong>
      <span v-if="step.note" class="note">{{ step.note }}</span>
      <em v-if="step.gate" class="ask">you're asked</em>
    </li>
  </ol>
</template>

<style scoped>
/* Theme variables only, so the light/dark toggle restyles it with no filter. */
.flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0;
  list-style: none;
  margin: 1rem 0 1.5rem;
  padding: 0;
}
.flow li {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  margin: 0;
  padding: 0.4rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}
.flow li + li {
  margin-left: 1.75rem;
}
.flow li + li::before {
  /* Empty alt text: screen readers already hear an ordered list. */
  content: "→" / "";
  position: absolute;
  left: -1.35rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--vp-c-text-2);
}
.flow .note,
.flow .ask {
  font-size: 0.8em;
}
.flow .note {
  color: var(--vp-c-text-2);
}
.flow li.gate {
  border: 2px solid var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.flow .ask {
  color: var(--vp-c-brand-1);
  font-style: normal;
  font-weight: 600;
}
</style>
