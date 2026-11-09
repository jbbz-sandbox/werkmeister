import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import dashboard from "../../../../docs/images/uis/dashboard-hero.png";
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
          src: dashboard,
          alt: "The workspaces dashboard: two workspaces, one working and one asking a question",
        }),
    }),
  enhanceApp({ app }) {
    app.component("FlowDiagram", FlowDiagram);
  },
};
