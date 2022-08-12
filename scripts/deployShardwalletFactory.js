const deploy = require("./deploy");

async function main() {
  deploy("ShardwalletFactory");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
