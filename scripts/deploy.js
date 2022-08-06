require("dotenv").config();
const hre = require("hardhat");

async function deployContract(contractFactoryName, ...args) {
  const factory = await hre.ethers.getContractFactory(contractFactoryName);
  const provider = new hre.ethers.providers.AlchemyProvider(
    "homestead",
    process.env.ALCHEMY_API_KEY
  );
  const signer = new hre.ethers.Wallet(
    process.env.MAINNET_PRIVATE_KEY,
    provider
  );

  const chainId = await signer.getChainId();
  const from = await signer.getAddress();
  const nonce = await signer.getTransactionCount();
  console.log("Chain ID: " + chainId);
  console.log("Deployer: " + from);
  console.log("Nonce: " + nonce);
  console.log(
    "Contract address: " + hre.ethers.utils.getContractAddress({ from, nonce })
  );
  console.log();

  const balance = await signer.getBalance();
  const deploymentTx = factory.getDeployTransaction(...args);
  const estimatedGas = await signer.estimateGas(deploymentTx);
  const estimatedGasPrice = await signer.getGasPrice();
  console.log(
    "Deployer balance: %s ETH",
    hre.ethers.utils.formatEther(balance)
  );
  console.log("Estimated gas: " + describeGas(estimatedGas, estimatedGasPrice));
  console.log();

  const argsPretty = args.map((x) => JSON.stringify(x)).join(", ");
  console.log(`Deploying ${contractFactoryName}(${argsPretty})...`);
  const contract = await factory.connect(signer).deploy(...args);
  console.log("Sent deploy transaction %s...", contract.deployTransaction.hash);
  const rx = await contract.deployTransaction.wait();

  console.log();
  console.log(
    "Deploy transaction mined: block #%s, hash %s",
    rx.blockNumber,
    rx.blockHash
  );
  console.log("Actual contract address: " + rx.contractAddress);
  console.log("Gas used: " + describeGas(rx.gasUsed, rx.effectiveGasPrice));
}

function describeGas(gas, price) {
  const priceStr = `${hre.ethers.utils.formatUnits(price, "gwei")} gwei/gas`;
  const totalStr = `${hre.ethers.utils.formatEther(gas.mul(price))} ETH`;
  return `${gas} gas @ ${priceStr} ~> ${totalStr}`;
}

module.exports = deployContract;
