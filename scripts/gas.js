const hre = require("hardhat");
const { ethers } = hre;

const TEST_CASES = [];

async function summon(props, signer) {
  const swf = await props.factories.ShardwalletFactory.connect(signer).deploy();
  const address = await signer.getAddress();
  const nonce = await swf.provider.getTransactionCount(address);
  const salt = address + nonce.toString(16).padStart(24, "0");
  const tx = await swf.summon(salt, "Shardwallet", "SHARD");
  const rx = await tx.wait();
  const events = rx.events.filter((e) => e.event === "ShardwalletCreation");
  if (events.length !== 1) {
    throw new Error(
      "expected exactly one ShardwalletCreation, got " + events.length
    );
  }
  const [event] = events;
  const sw = props.factories.Shardwallet.attach(event.args.shardwallet);
  return { sw, deployTransaction: tx };
}

TEST_CASES.push(async function* deployShardwalletFactory(props) {
  const swf = await props.factories.ShardwalletFactory.deploy();
  await swf.deployed();
  yield ["ShardwalletFactory deploy", await swf.deployTransaction.wait()];
});

TEST_CASES.push(async function* deployShardwallet(props) {
  const [alice] = props.signers;
  const { sw, deployTransaction } = await summon(props, alice);
  yield ["Shardwallet deploy", await deployTransaction.wait()];
});

TEST_CASES.push(async function* deployMintPassAndQql(props) {
  const mp = await props.factories.MintPass.deploy(999);
  await mp.deployed();
  yield ["MintPass deploy", await mp.deployTransaction.wait()];

  const qql = await props.factories.QQL.deploy(mp.address, 999, 0);
  await qql.deployed();
  yield ["QQL deploy", await qql.deployTransaction.wait()];
});

TEST_CASES.push(async function* shardwalletBasics(props) {
  const [alice] = props.signers;
  const { sw } = await summon(props, alice);
  await sw.deployed();
  const weth9 = await props.factories.TestERC20.deploy();
  await weth9.deployed();

  // Populate the ERC-20 balance storage slot for the claim recipient so that
  // we don't pay that gas cost while profiling.
  await weth9.mint(alice.address, 1);

  const ETH = ethers.constants.AddressZero; // as an `IERC20`
  const oneMillion = 1e6;
  await alice.sendTransaction({ to: sw.address, value: oneMillion });
  await weth9.mint(sw.address, oneMillion);

  yield [
    "Shardwallet: split with 3 children",
    await sw
      .split(1, [
        { shareMicros: 500000, recipient: alice.address }, // shard 2
        { shareMicros: 300000, recipient: alice.address }, // shard 3
        { shareMicros: 100000, recipient: alice.address }, // shard 4
        { shareMicros: 100000, recipient: alice.address }, // shard 5
      ])
      .then((tx) => tx.wait()),
  ];

  yield [
    "Shardwallet: merge with 2 parents",
    await sw.merge([4, 5]).then((tx) => tx.wait()), // shard 6
  ];

  yield [
    "Shardwallet: ETH claim initializing 3 records",
    await sw.claim(6, [ETH], 1e6).then((tx) => tx.wait()),
  ];
  yield [
    "Shardwallet: ERC-20 claim initializing 3 records",
    await sw.claim(6, [weth9.address], 1e6).then((tx) => tx.wait()),
  ];

  yield [
    "Shardwallet: ETH claim initializing 1 record",
    await sw.claim(2, [ETH], 1e6).then((tx) => tx.wait()),
  ];
  yield [
    "Shardwallet: ERC-20 claim initializing 1 record",
    await sw.claim(2, [weth9.address], 1e6).then((tx) => tx.wait()),
  ];

  yield [
    "Shardwallet: no-op ETH claim",
    await sw.claim(2, [ETH], 1e6).then((tx) => tx.wait()),
  ];
  yield [
    "Shardwallet: no-op ERC-20 claim",
    await sw.claim(2, [weth9.address], 1e6).then((tx) => tx.wait()),
  ];

  await alice.sendTransaction({ to: sw.address, value: oneMillion });
  await weth9.mint(sw.address, oneMillion);

  yield [
    "Shardwallet: ETH claim updating 1 existing record (typical claim)",
    await sw.claim(2, [ETH], 1e6).then((tx) => tx.wait()),
  ];
  yield [
    "Shardwallet: ERC-20 claim updating 1 existing record (typical claim)",
    await sw.claim(2, [weth9.address], 1e6).then((tx) => tx.wait()),
  ];
  yield [
    "Shardwallet: combined ETH/ERC-20 claim updating 1 existing record per currency (typical claim)",
    await sw.claim(6, [ETH, weth9.address], 1e6).then((tx) => tx.wait()),
  ];

  yield [
    "Shardwallet: reforging 3 parents into 2 children",
    await sw
      .reforge(
        [2, 3, 6],
        [
          { shareMicros: 800000, recipient: alice.address }, // shard 7
          { shareMicros: 200000, recipient: alice.address }, // shard 8
        ]
      )
      .then((tx) => tx.wait()),
  ];
});

TEST_CASES.push(async function* shardwalletManyChildren(props) {
  const [alice] = props.signers;
  const { sw } = await summon(props, alice);
  await sw.deployed();

  const oneMillion = 1e6;
  const ETH = ethers.constants.AddressZero; // as an `IERC20`

  let shard = 1;
  await alice.sendTransaction({ to: sw.address, value: oneMillion + 1 });
  await sw.claim(shard, [ETH], 1e6);

  const siblingCounts = [4, 20, 100];
  for (let i = 0; i < siblingCounts.length; i++) {
    const siblings = siblingCounts[i];
    const lastSiblings = siblingCounts[i - 1] ?? 1;
    const childShare = oneMillion / siblings;
    if (!Number.isInteger(childShare))
      throw new Error(`fix test constants (${siblings}): ${childShare}`);
    await alice.sendTransaction({ to: sw.address, value: oneMillion + 1 });
    yield [
      `Shardwallet: initial claim with ${lastSiblings} parents`,
      await sw.claim(shard, [ETH], 1e6).then((tx) => tx.wait()),
    ];

    await sw.split(
      shard,
      Array(siblings).fill({
        shareMicros: childShare,
        recipient: alice.address,
      })
    );
    yield [
      `Shardwallet: initial claim with ${siblings} siblings`,
      await sw.claim(shard + 1, [ETH], 1e6).then((tx) => tx.wait()),
    ];

    await sw.merge(
      Array(siblings)
        .fill()
        .map((_, i) => shard + 1 + i)
    );
    shard += 1 + siblings;
  }
});

TEST_CASES.push(async function* shardwalletLongChains(props) {
  const [alice] = props.signers;
  const { sw } = await summon(props, alice);
  await sw.deployed();
  const weth9 = await props.factories.TestERC20.deploy();
  await weth9.deployed();

  // Populate the ERC-20 balance storage slot for the claim recipient so that
  // we don't pay that gas cost while profiling.
  await weth9.mint(alice.address, 1);

  const oneMillion = 1e6;
  await alice.sendTransaction({ to: sw.address, value: oneMillion });
  await weth9.mint(sw.address, oneMillion);

  const fanOut = 10;
  const childShare = oneMillion / fanOut;
  if (!Number.isInteger(childShare))
    throw new Error("fix test constants: " + childShare);
  const generations = 8;
  let shard = 1;
  for (let i = 0; i < generations; i++) {
    await sw.split(
      shard,
      Array(fanOut).fill({ shareMicros: childShare, recipient: alice.address })
    );
    await sw.merge(
      Array(fanOut)
        .fill()
        .map((_, i) => shard + i + 1)
    );
    shard += fanOut + 1;
  }

  yield [
    "Shardwallet: first claim over long chain",
    await sw.claim(shard, [weth9.address], 1e6).then((tx) => tx.wait()),
  ];
});

TEST_CASES.push(async function* scriptPieces(props) {
  const [owner] = props.signers;

  const mp = await props.factories.MintPass.deploy(999);
  const qql = await props.factories.QQL.deploy(mp.address, 999, 0);

  yield [
    "QQL: set 1024-byte script piece",
    await qql.setScriptPiece(1, "U".repeat(1024)).then((tx) => tx.wait()),
  ];

  yield [
    "QQL: set 8192-byte script piece",
    await qql.setScriptPiece(2, "U".repeat(8192)).then((tx) => tx.wait()),
  ];
});

const Mode = Object.freeze({
  TEXT: "TEXT",
  JSON: "JSON",
});

async function main() {
  await hre.run("compile", { quiet: true });
  const { mode, patterns } = parseArgs();
  function testCaseMatches(name) {
    if (patterns.length === 0) return true;
    return patterns.some((p) => name.match(p));
  }
  const contractNames = [
    "MintPass",
    "QQL",
    "Shardwallet",
    "ShardwalletFactory",
    "TestERC20",
  ];
  const factories = {};
  await Promise.all(
    contractNames.map(async (name) => {
      factories[name] = await ethers.getContractFactory(name);
    })
  );
  let allPassed = true;
  for (const testCase of TEST_CASES) {
    if (!testCaseMatches(testCase.name)) continue;
    try {
      const gen = testCase({
        factories,
        signers: await ethers.getSigners(),
      });
      for await (const [label, gasOrReceipt] of gen) {
        let gas;
        if (ethers.BigNumber.isBigNumber(gasOrReceipt.gasUsed)) {
          gas = gasOrReceipt.gasUsed;
        } else {
          gas = gasOrReceipt;
        }
        switch (mode) {
          case Mode.TEXT:
            console.log(`${label}: ${formatGas(gas)}`);
            break;
          case Mode.JSON: {
            const keccak = ethers.utils.keccak256(
              ethers.utils.toUtf8Bytes(label)
            );
            const hash = ethers.BigNumber.from(
              ethers.utils.hexDataSlice(keccak, 0, 6)
            )
              .toBigInt()
              .toString(32)
              .padStart(10, "0");
            const blob = { hash, label, gas: gas.toString() };
            console.log(JSON.stringify(blob));
            break;
          }
          default:
            throw new Error(`Unexpected mode: ${mode}`);
        }
      }
    } catch (e) {
      allPassed = false;
      console.error(`Error in ${testCase.name}:`, e);
    }
  }
  if (!allPassed) process.exitCode = 1;
}

function parseArgs() {
  let mode = Mode.TEXT;
  const rawArgs = process.argv.slice(2);
  const patterns = [];
  let moreFlags = true;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (moreFlags && arg === "--") {
      moreFlags = false;
      continue;
    }
    if (moreFlags && arg.startsWith("-")) {
      if (arg === "-j" || arg === "--json") {
        mode = Mode.JSON;
        continue;
      }
      if (arg === "-t" || arg === "--text") {
        mode = Mode.TEXT;
        continue;
      }
      throw `In argument ${i + 1}: Unknown flag "${arg}"`;
    }
    try {
      patterns.push(RegExp(arg, "i"));
    } catch (e) {
      throw `In argument ${i + 1}: ${e.message}`;
    }
  }
  return { patterns, mode };
}

function formatGas(gas, samplePrice = 10n ** 9n * 50n) {
  const sampleCost = ethers.utils.formatUnits(gas.mul(samplePrice));
  const gweiStr = ethers.utils.formatUnits(samplePrice, 9);
  const costStr = `${sampleCost} ETH @ ${gweiStr} gwei/gas`;
  return `${gas.toString()} gas (${costStr})`;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
