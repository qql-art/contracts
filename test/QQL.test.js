const { expect } = require("chai");
const BN = ethers.BigNumber;

const testTokenUriDelegate = require("./tokenUriDelegate.js");

describe("QQL", () => {
  let MintPass;
  let QQL;

  function generateHash(address, rest) {
    return ethers.utils.solidityPack(["address", "uint96"], [address, rest]);
  }

  // Sets the time for the next block but does not mine it.
  async function setNextTimestamp(timestamp) {
    timestamp = Number(timestamp);
    await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  }
  async function mine() {
    await ethers.provider.send("evm_mine", []);
  }

  before(async () => {
    MintPass = await ethers.getContractFactory("MintPass");
    Clock = await ethers.getContractFactory("Clock");
    QQL = await ethers.getContractFactory("QQL");

    clock = await Clock.deploy();
  });

  async function setup() {
    const mintPass = await MintPass.deploy(9);
    await mintPass.deployed();
    const qql = await QQL.deploy(mintPass.address, 3, 0);
    const signers = await ethers.getSigners();
    const passHolder = signers[1];
    await mintPass.reserve(passHolder.address, 3);
    await mintPass.setBurner(qql.address);
    const hash = generateHash(passHolder.address, 1);
    return { passHolder, mintPass, qql, signers, hash };
  }

  describe("minting", () => {
    it("minting works as expected", async () => {
      const { passHolder, mintPass, qql, signers, hash } = await setup();
      expect(await qql.tokenHashToId(hash)).to.equal(0);
      expect(await qql.tokenHash(1)).to.equal(ethers.constants.HashZero);
      await qql.connect(passHolder).mint(1, hash);
      expect(await qql.balanceOf(passHolder.address)).to.equal(1);
      expect(await qql.tokenHash(1)).to.equal(hash);
      expect(await qql.tokenHashToId(hash)).to.equal(1);
      expect(await qql.ownerOf(1)).to.equal(passHolder.address);
      expect(await mintPass.balanceOf(passHolder.address)).to.equal(2);
      // can't double-mint
      await expect(qql.connect(passHolder).mint(1, hash)).to.be.revertedWith(
        "nonexistent token"
      );
    });

    it("can only mint before unlock timestamp if it is a premint pass", async () => {
      const mintPass = await MintPass.deploy(9);
      await mintPass.deployed();
      const unlockTimestamp = +(await clock.timestamp()) + 10;
      const qql = await QQL.deploy(mintPass.address, 2, unlockTimestamp);
      const signers = await ethers.getSigners();
      const passHolder = signers[1];
      await mintPass.reserve(passHolder.address, 3);
      await mintPass.setBurner(qql.address);
      const hash1 = generateHash(passHolder.address, 1);
      expect(qql.connect(passHolder).mint(3, hash1)).to.be.revertedWith(
        "not yet unlocked"
      );
      await qql.connect(passHolder).mint(2, hash1);
      const hash2 = generateHash(passHolder.address, 2);
      await setNextTimestamp(unlockTimestamp);
      await mine();
      await qql.connect(passHolder).mint(3, hash2);
    });

    it("only owner or approved can mint", async () => {
      const { passHolder, mintPass, qql, signers, hash } = await setup();
      const operator = signers[2];
      const fail = qql
        .connect(operator)
        .mint(1, generateHash(operator.address, 0));
      await expect(fail).to.be.revertedWith("owner or approved");
      await mintPass.connect(passHolder).approve(operator.address, 1);
      await qql.connect(operator).mint(1, generateHash(operator.address, 1));
      await mintPass
        .connect(passHolder)
        .setApprovalForAll(operator.address, true);
      await qql.connect(operator).mint(2, generateHash(operator.address, 2));
      expect(await qql.balanceOf(operator.address)).to.equal(2);
    });

    it("hash must match minter address", async () => {
      const { passHolder, mintPass, qql, signers, hash } = await setup();
      const operator = signers[2];
      const fail = qql
        .connect(passHolder)
        .mint(1, generateHash(operator.address, 0));
      await expect(fail).to.be.revertedWith("minter does not match hash");
    });

    it("hash must be unique", async () => {
      const { passHolder, mintPass, qql, signers, hash } = await setup();
      await qql.connect(passHolder).mint(1, hash);
      const fail = qql.connect(passHolder).mint(2, hash);
      await expect(fail).to.be.revertedWith("hash already used");
    });
  });

  it("token royalty recipient works", async () => {
    const { passHolder, qql, hash, signers } = await setup();
    const owner = signers[0];
    expect(await qql.tokenRoyaltyRecipient(1)).to.equal(
      ethers.constants.AddressZero
    );
    await qql.connect(passHolder).mint(1, hash);
    expect(await qql.tokenRoyaltyRecipient(1)).to.equal(passHolder.address);
    const fail1 = qql.changeTokenRoyaltyRecipient(1, owner.address);
    await expect(fail1).to.be.revertedWith("QQL: unauthorized");
    const fail2 = qql
      .connect(passHolder)
      .changeTokenRoyaltyRecipient(1, ethers.constants.AddressZero);
    await expect(fail2).to.be.revertedWith("QQL: Can't set zero address");
    await qql.connect(passHolder).changeTokenRoyaltyRecipient(1, owner.address);
    expect(await qql.tokenRoyaltyRecipient(1)).to.equal(owner.address);
  });

  it("project royalty recipient works", async () => {
    const { passHolder, qql, hash, signers } = await setup();
    const owner = signers[0];
    expect(await qql.projectRoyaltyRecipient()).to.equal(
      ethers.constants.AddressZero
    );

    await qql.setProjectRoyaltyRecipient(passHolder.address);
    expect(await qql.projectRoyaltyRecipient()).to.equal(passHolder.address);

    const fail = qql
      .connect(passHolder)
      .setProjectRoyaltyRecipient(owner.address);
    await expect(fail).to.be.revertedWith("not the owner");
  });

  it("getRoyalties works", async () => {
    const { passHolder, qql, hash, signers } = await setup();
    const owner = signers[0];
    await qql.setProjectRoyaltyRecipient(owner.address);

    const fail = qql.getRoyalties(1);
    await expect(fail).to.be.revertedWith("QQL: royalty for nonexistent token");

    await qql.connect(passHolder).mint(1, hash);
    expect(await qql.tokenRoyaltyRecipient(1)).to.equal(passHolder.address);
    expect(await qql.getRoyalties(1)).to.deep.equal([
      [owner.address, passHolder.address],
      [ethers.BigNumber.from(500), ethers.BigNumber.from(200)],
    ]);

    await qql.connect(passHolder).changeTokenRoyaltyRecipient(1, owner.address);
    expect(await qql.tokenRoyaltyRecipient(1)).to.equal(owner.address);
    expect(await qql.getRoyalties(1)).to.deep.equal([
      [owner.address, owner.address],
      [ethers.BigNumber.from(500), ethers.BigNumber.from(200)],
    ]);
  });

  it("script pieces work", async () => {
    const mintPass = await MintPass.deploy(9);
    await mintPass.deployed();
    const qql = await QQL.deploy(mintPass.address, 9, 0);
    const signers = await ethers.getSigners();
    const a = signers[1];
    await expect(qql.connect(a).setScriptPiece(0, "hmm")).to.be.revertedWith(
      "owner"
    );
    await qql.setScriptPiece(0, "hmm");
    await qql.setScriptPiece(1, "ham");
    expect(await qql.scriptPiece(0)).to.equal("hmm");
    expect(await qql.scriptPiece(1)).to.equal("ham");
    await expect(qql.setScriptPiece(0, "oops")).to.be.revertedWith("immutable");
  });

  testTokenUriDelegate(async () => {
    const {
      qql,
      passHolder,
      hash,
      signers: [owner, nonOwner],
    } = await setup();
    await qql.connect(passHolder).mint(1, hash);
    const tokenId = 1;
    const nonTokenId = 9999;
    return { contract: qql, owner, nonOwner, tokenId, nonTokenId };
  });

  describe("supportsInterface", () => {
    let qql;
    before(async () => {
      qql = await QQL.deploy(ethers.constants.AddressZero, 3, 0);
    });

    const cases = [
      ["ERC165", 0x01ffc9a7, true],
      ["ERC721", 0x80ac58cd, true],
      ["ERC721Enumerable", 0x780e9d63, true],
      ["ERC721Metadata", 0x5b5e139f, true],
      ["false sentinel", 0xffffffff, false],
    ];

    for (const [name, id, impl] of cases) {
      it(`${impl ? "implements" : "does not implement"} ${name}`, async () => {
        expect(await qql.supportsInterface(id)).to.equal(impl);
      });
    }
  });
});
