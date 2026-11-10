import { createTarget } from "./server.js";

const port = Number(process.env["PORT"] ?? 8080);
createTarget().listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "synthetic_target_ready", port }));
});
