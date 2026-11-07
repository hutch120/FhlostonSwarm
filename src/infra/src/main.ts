import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

buildApp(loadConfig()).synth();
