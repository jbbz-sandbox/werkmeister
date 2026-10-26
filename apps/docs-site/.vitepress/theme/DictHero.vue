<script setup>
import { useData } from "vitepress";

const { frontmatter } = useData();
const hero = frontmatter.value.hero;
const headword = hero.name.split("|").join('<span class="bar">|</span>');
</script>

<template>
  <h1 class="heading">
    <span class="name clip" v-html="headword"></span>
    <span class="dict-head">{{ hero.ipa }} · {{ hero.said }} · <span v-html="hero.grammar"></span></span>
  </h1>
  <p class="dict-senses">
    <template v-for="(sense, i) in hero.senses" :key="i">
      <b class="dict-n">{{ i + 1 }}</b> <span v-html="sense"></span>{{ " " }}
    </template>
    <small>[<span v-html="hero.etymology"></span>]</small>
  </p>
  <p class="text" v-html="hero.text"></p>
  <p class="tagline" v-html="hero.tagline"></p>
</template>

<style scoped>
/* VPHero's styles are scoped to its own elements, so slot content restates the
   sizes it would have had: name/text at hero size, tagline at 18px. */
.heading {
  display: flex;
  flex-direction: column;
}
.name,
.text {
  width: fit-content;
  max-width: 392px;
  letter-spacing: -0.4px;
  line-height: 40px;
  font-size: 32px;
  font-weight: 700;
  white-space: pre-wrap;
}
.text {
  margin-top: 16px;
}
.clip {
  background: var(--vp-home-hero-name-background);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: var(--vp-home-hero-name-color);
}
.clip :deep(.bar) {
  opacity: 0.45;
}
.dict-head {
  padding-top: 4px;
  line-height: 28px;
  font-size: 18px;
  font-weight: 400;
  color: var(--vp-c-text-2);
}
.dict-senses {
  padding-top: 12px;
  max-width: 592px;
  line-height: 28px;
  font-size: 18px;
  color: var(--vp-c-text-1);
}
.dict-senses small {
  display: block;
  padding-top: 8px;
  font-size: 14px;
  line-height: 22px;
  color: var(--vp-c-text-2);
}
.dict-n {
  display: inline-block;
  min-width: 1.5em;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 0.75em;
  line-height: 1.5;
  text-align: center;
}
.tagline {
  padding-top: 8px;
  max-width: 392px;
  line-height: 28px;
  font-size: 18px;
  font-weight: 500;
  white-space: pre-wrap;
  color: var(--vp-c-text-2);
}
@media (min-width: 640px) {
  .name,
  .text {
    max-width: 576px;
    line-height: 56px;
    font-size: 48px;
  }
  .tagline {
    max-width: 576px;
    line-height: 32px;
    font-size: 20px;
  }
}
@media (min-width: 960px) {
  .name,
  .text {
    line-height: 64px;
    font-size: 56px;
  }
}
</style>
