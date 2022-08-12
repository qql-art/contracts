const { expect } = require("chai");
const hre = require("hardhat");

describe("ShardwalletFactory", () => {
  let Shardwallet;
  let ShardwalletFactory;

  before(async () => {
    Shardwallet = await ethers.getContractFactory("Shardwallet");
    ShardwalletFactory = await ethers.getContractFactory("ShardwalletFactory");
  });

  function makeSalt(address, nonce) {
    return ethers.utils.solidityPack(["address", "uint96"], [address, nonce]);
  }

  it("deploys a master copy Shardwallet on construction", async () => {
    const swf = await ShardwalletFactory.deploy();
    const implAddress = ethers.utils.getContractAddress({
      from: swf.address,
      nonce: 1,
    });
    expect(await swf.implementation()).to.equal(implAddress);

    const swArtifact = await hre.artifacts.readArtifact("Shardwallet");
    expect(await swf.provider.getCode(implAddress)).to.equal(
      swArtifact.deployedBytecode
    );
  });

  it("locks the master copy Shardwallet", async () => {
    const [deployer] = await ethers.getSigners();
    const swf = await ShardwalletFactory.deploy();
    const implementation = Shardwallet.attach(await swf.implementation());
    await expect(
      implementation.initialize(deployer.address)
    ).to.be.revertedWith("Initializable:");
    expect(await implementation.owner()).to.equal(swf.address);
  });

  it("properly predicts addresses and emits events upon summoning", async () => {
    const [deployer] = await ethers.getSigners();
    const swf = await ShardwalletFactory.deploy();

    const salt = makeSalt(deployer.address, 0);
    const sw = Shardwallet.attach(await swf.predictAddress(salt));

    const summonTx = await swf.summon(salt);
    await expect(summonTx)
      .to.emit(swf, "ShardwalletCreation")
      .withArgs(sw.address, deployer.address);
    await expect(summonTx)
      .to.emit(sw, "Transfer")
      .withArgs(ethers.constants.AddressZero, deployer.address, 1);

    expect(await sw.owner()).to.equal(deployer.address);
    expect(await sw.ownerOf(1)).to.equal(deployer.address);
  });

  it("reverts on salt reuse", async () => {
    const [deployer] = await ethers.getSigners();
    const swf = await ShardwalletFactory.deploy();
    const salt = makeSalt(deployer.address, 0);
    await swf.summon(salt);
    await expect(swf.summon(salt)).to.be.revertedWith(
      "ERC1167: create2 failed"
    );
  });

  it("reverts on salt not matching address", async () => {
    const [, notDeployer] = await ethers.getSigners();
    const swf = await ShardwalletFactory.deploy();
    const salt = makeSalt(notDeployer.address, 0);
    await expect(swf.summon(salt)).to.be.revertedWith(
      "ShardwalletFactory: unauthorized"
    );
  });
});
