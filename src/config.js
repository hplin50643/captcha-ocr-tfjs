const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const LABELS = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

function extensionDirectory() {
  return process.env.CAPTCHA_EXTENSION_DIR
    ? path.resolve(process.env.CAPTCHA_EXTENSION_DIR)
    : path.resolve(ROOT, "../admis-captcha-extension");
}

module.exports = { ROOT, LABELS, extensionDirectory };
