const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
let checked = 0;
for (const dir of ["src", "scripts", "test"]) {
  const target = path.resolve(root, dir);
  if (!fs.existsSync(target)) continue;
  for (const name of fs.readdirSync(target, { recursive: true }).filter((s) => s.endsWith(".js"))) {
    const result = spawnSync(process.execPath, ["--check", path.join(target, name)], {
      stdio: "inherit"
    });
    if (result.status !== 0) process.exit(result.status || 1);
    checked++;
  }
}
console.log(`Syntax checked ${checked} JavaScript files.`);
