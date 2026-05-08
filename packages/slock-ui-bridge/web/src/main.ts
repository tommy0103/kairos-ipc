import { createApp } from "vue";
import App from "./App.vue";
import { chromatixPlugin } from "./theme/chromatix";
import "./style.css";

const app = createApp(App);
app.use(chromatixPlugin);
app.mount("#app");
