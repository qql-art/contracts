const deploy = require("./deploy");

async function main() {
  deploy("Shardwallet");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
