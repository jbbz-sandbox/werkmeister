import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import hero from "../../../../docs/images/uis/vscode-hero.png";
import DictHero from "./DictHero.vue";
import FlowDiagram from "./FlowDiagram.vue";
import "./custom.css";

// The landing hero reads as a dictionary entry (SW-98): the entry replaces the
// default name/text/tagline block, the theme still draws the action buttons.
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "home-hero-info": () => h(DictHero),
      "home-hero-after": () =>
        h("img", {
          class: "home-dashboard",
          src: hero,
          alt: "The werkmeister VS Code extension beside the Claude terminal: the workspace in the terminal is outlined, another asks a question",
        }),
    }),
  enhanceApp({ app }) {
    app.component("FlowDiagram", FlowDiagram);
  },
};
