const deploy = require("./deploy");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error("usage: deployMintPass <MAX_CREATED>");
  }
  const [rawMaxCreated] = args;
  const maxCreated = Number.parseInt(rawMaxCreated, 10);
  if (String(maxCreated) !== rawMaxCreated) {
    throw new Error("bad maxCreated: " + rawMaxCreated);
  }
  await deploy("MintPass", maxCreated);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
