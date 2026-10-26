import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import DictHero from "./DictHero.vue";
import "./custom.css";

// The landing hero reads as a dictionary entry (SW-98): the entry replaces the
// default name/text/tagline block, the theme still draws the action buttons.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-info": () => h(DictHero) }),
};
