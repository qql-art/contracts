const { expect } = require("chai");
const BN = ethers.BigNumber;

const testOperatorFilter = require("./operatorFilter.js");
const testTokenUriDelegate = require("./tokenUriDelegate.js");

describe("QQL", () => {
  let MintPass;
  let QQL;

  function generateSeed(address, rest) {
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
    const seed = generateSeed(passHolder.address, 1);
    return { passHolder, mintPass, qql, signers, seed };
  }

  it("constructor accessors work", async () => {
    const mintPass = await MintPass.deploy(9);
    await mintPass.deployed();
    const qql = await QQL.deploy(mintPass.address, 3, 1000);
    expect(await qql.unlockTimestamp()).to.equal(1000);
    expect(await qql.maxPremintPassId()).to.equal(3);
  });

  describe("minting", () => {
    it("minting works as expected", async () => {
      const { passHolder, mintPass, qql, signers, seed } = await setup();
      expect(await qql.seedToTokenId(seed)).to.equal(0);
      expect(await qql.tokenSeed(1)).to.equal(ethers.constants.HashZero);
      await qql.connect(passHolder).mint(1, seed);
      expect(await qql.balanceOf(passHolder.address)).to.equal(1);
      expect(await qql.tokenSeed(1)).to.equal(seed);
      expect(await qql.seedToTokenId(seed)).to.equal(1);
      expect(await qql.ownerOf(1)).to.equal(passHolder.address);
      expect(await mintPass.balanceOf(passHolder.address)).to.equal(2);
      // can't double-mint
      await expect(qql.connect(passHolder).mint(1, seed)).to.be.revertedWith(
        "nonexistent token"
      );
      await expect(
        qql.connect(passHolder).mintTo(1, seed, passHolder.address)
      ).to.be.revertedWith("nonexistent token");
    });

    it("parametricArtist works as intended", async () => {
      const { passHolder, mintPass, qql, signers, seed } = await setup();
      const fail = qql.parametricArtist(1);
      await expect(fail).to.be.revertedWith("token does not exist");
      await qql.connect(passHolder).mint(1, seed);
      expect(await qql.parametricArtist(1)).to.equal(passHolder.address);
      const owner = signers[0];
      await qql
        .connect(passHolder)
        .changeTokenRoyaltyRecipient(1, owner.address);
      expect(await qql.parametricArtist(1)).to.equal(passHolder.address);
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
      const seed1 = generateSeed(passHolder.address, 1);
      expect(qql.connect(passHolder).mint(3, seed1)).to.be.revertedWith(
        "not yet unlocked"
      );
      expect(
        qql.connect(passHolder).mintTo(3, seed1, passHolder.address)
      ).to.be.revertedWith("not yet unlocked");
      await qql.connect(passHolder).mint(2, seed1);
      const seed2 = generateSeed(passHolder.address, 2);
      await setNextTimestamp(unlockTimestamp);
      await mine();
      await qql.connect(passHolder).mint(3, seed2);
    });

    it("only owner or approved can mint", async () => {
      const { passHolder, mintPass, qql, signers, seed } = await setup();
      const operator = signers[2];
      let fail = qql
        .connect(operator)
        .mint(1, generateSeed(operator.address, 0));
      await expect(fail).to.be.revertedWith("unauthorized");
      fail = qql
        .connect(operator)
        .mintTo(1, generateSeed(operator.address, 0), operator.address);
      await expect(fail).to.be.revertedWith("unauthorized");
      await mintPass.connect(passHolder).approve(operator.address, 1);
      await qql.connect(operator).mint(1, generateSeed(operator.address, 1));
      await mintPass
        .connect(passHolder)
        .setApprovalForAll(operator.address, true);
      await qql.connect(operator).mint(2, generateSeed(operator.address, 2));
      expect(await qql.balanceOf(operator.address)).to.equal(2);
    });

    it("cannot mint another artist's seed without approval", async () => {
      const { passHolder, qql, signers, seed } = await setup();
      const operator = signers[2];
      const fail = qql
        .connect(passHolder)
        .mint(1, generateSeed(operator.address, 0));
      await expect(fail).to.be.revertedWith("unauthorized");
    });

    it("seeds may be transferred", async () => {
      const {
        qql,
        signers: [a, b, c],
      } = await setup();

      const s = generateSeed(a.address, 0);
      expect(await qql.ownerOfSeed(s)).to.equal(a.address);

      const transfer = qql.connect(a).transferSeed(a.address, b.address, s);
      await expect(transfer)
        .to.emit(qql, "SeedTransfer")
        .withArgs(a.address, b.address, s);
      expect(await qql.ownerOfSeed(s)).to.equal(b.address);

      const fail1 = qql.connect(a).transferSeed(a.address, c.address, s);
      await expect(fail1).to.be.revertedWith("unauthorized");
      const fail2 = qql.connect(a).transferSeed(b.address, c.address, s);
      await expect(fail2).to.be.revertedWith("unauthorized");

      const fail3 = qql.connect(b).transferSeed(a.address, c.address, s);
      await expect(fail3).to.be.revertedWith("wrong owner");

      await qql.connect(b).transferSeed(b.address, c.address, s);
      expect(await qql.ownerOfSeed(s)).to.equal(c.address);

      const approve = qql.connect(c).approveForAllSeeds(a.address, true);
      await qql.connect(a).transferSeed(c.address, a.address, s);
      expect(await qql.ownerOfSeed(s)).to.equal(a.address);
    });

    it("seed approval works as intended", async () => {
      const {
        qql,
        signers: [a, b, c],
      } = await setup();
      expect(await qql.isApprovedForAllSeeds(c.address, a.address)).to.equal(
        false
      );
      const approve = qql.connect(c).approveForAllSeeds(a.address, true);
      await expect(approve)
        .to.emit(qql, "ApprovalForAllSeeds")
        .withArgs(c.address, a.address, true);
      expect(await qql.isApprovedForAllSeeds(c.address, a.address)).to.equal(
        true
      );
      const disapprove = qql.connect(c).approveForAllSeeds(a.address, false);
      await expect(disapprove)
        .to.emit(qql, "ApprovalForAllSeeds")
        .withArgs(c.address, a.address, false);
      expect(await qql.isApprovedForAllSeeds(c.address, a.address)).to.equal(
        false
      );
    });

    it("seeds may not be sent to the zero address", async () => {
      const {
        qql,
        signers: [a, b, c],
      } = await setup();

      const s = generateSeed(a.address, 0);

      const fail = qql
        .connect(a)
        .transferSeed(a.address, ethers.constants.AddressZero, s);
      await expect(fail).to.be.revertedWith("zero address");
    });

    it("transferred seeds may be minted", async () => {
      const { passHolder, qql, signers } = await setup();
      const artist = signers[2];
      if (artist.address === passHolder.address)
        throw new Error("fix test setup");

      const seed = generateSeed(artist.address, 0);

      const fail = qql.connect(passHolder).mint(1, seed);
      await expect(fail).to.be.revertedWith("unauthorized");
      await qql
        .connect(artist)
        .transferSeed(artist.address, passHolder.address, seed);
      const badMint = qql.connect(artist).mint(1, seed);
      await expect(badMint).to.be.revertedWith("unauthorized");

      const mint = qql.connect(passHolder).mint(1, seed);
      await expect(mint)
        .to.emit(qql, "Transfer")
        .withArgs(ethers.constants.AddressZero, passHolder.address, 1);

      expect(await qql.ownerOf(1)).to.equal(passHolder.address);
      expect(await qql.tokenRoyaltyRecipient(1)).to.equal(artist.address);
    });

    it("approval for seeds enables minting", async () => {
      const { passHolder, qql, signers } = await setup();
      const artist = signers[2];
      if (artist.address === passHolder.address)
        throw new Error("fix test setup");

      const seed = generateSeed(artist.address, 0);

      const fail = qql.connect(passHolder).mint(1, seed);
      await expect(fail).to.be.revertedWith("unauthorized");
      await qql.connect(artist).approveForAllSeeds(passHolder.address, true);
      const mint = qql.connect(passHolder).mint(1, seed);
      await expect(mint)
        .to.emit(qql, "Transfer")
        .withArgs(ethers.constants.AddressZero, passHolder.address, 1);

      expect(await qql.ownerOf(1)).to.equal(passHolder.address);
      expect(await qql.tokenRoyaltyRecipient(1)).to.equal(artist.address);
    });

    it("seed must be unique", async () => {
      const { passHolder, mintPass, qql, signers, seed } = await setup();
      await qql.connect(passHolder).mint(1, seed);
      const fail = qql.connect(passHolder).mint(2, seed);
      await expect(fail).to.be.revertedWith("seed already used");
    });

    it("mintTo enables minting to the owner of a seed", async () => {
      const { passHolder, mintPass, qql, signers } = await setup();
      const artist = signers[2];
      const recipient = signers[3];
      if (artist.address === passHolder.address)
        throw new Error("fix test setup");
      const seed = generateSeed(artist.address, 0);
      await qql
        .connect(artist)
        .transferSeed(artist.address, recipient.address, seed);
      const mint = qql.connect(passHolder).mintTo(1, seed, recipient.address);
      await expect(mint)
        .to.emit(qql, "Transfer")
        .withArgs(ethers.constants.AddressZero, recipient.address, 1);
      expect(await qql.ownerOf(1)).to.equal(recipient.address);
      expect(await qql.tokenRoyaltyRecipient(1)).to.equal(artist.address);
    });

    it("mintTo enables minting to the operator of a seed", async () => {
      const { passHolder, mintPass, qql, signers } = await setup();
      const artist = signers[2];
      const recipient = signers[3];
      if (artist.address === passHolder.address)
        throw new Error("fix test setup");
      const seed = generateSeed(artist.address, 0);
      await qql.connect(artist).approveForAllSeeds(recipient.address, true);
      const mint = qql.connect(passHolder).mintTo(1, seed, recipient.address);
      await expect(mint)
        .to.emit(qql, "Transfer")
        .withArgs(ethers.constants.AddressZero, recipient.address, 1);
      expect(await qql.ownerOf(1)).to.equal(recipient.address);
      expect(await qql.tokenRoyaltyRecipient(1)).to.equal(artist.address);
    });

    it("can mint to an artist (leaving the artist with the QQL)", async () => {
      const { passHolder, mintPass, qql, signers } = await setup();
      const artist = signers[2];
      if (artist.address === passHolder.address)
        throw new Error("fix test setup");
      const seed = generateSeed(artist.address, 0);
      const mint = qql.connect(passHolder).mintTo(1, seed, artist.address);
      await expect(mint)
        .to.emit(qql, "Transfer")
        .withArgs(ethers.constants.AddressZero, artist.address, 1);
      expect(await qql.ownerOf(1)).to.equal(artist.address);
      expect(await qql.tokenRoyaltyRecipient(1)).to.equal(artist.address);
    });
  });

  it("token royalty recipient works", async () => {
    const { passHolder, qql, seed, signers } = await setup();
    const owner = signers[0];
    expect(await qql.tokenRoyaltyRecipient(1)).to.equal(
      ethers.constants.AddressZero
    );
    await qql.connect(passHolder).mint(1, seed);
    expect(await qql.tokenRoyaltyRecipient(1)).to.equal(passHolder.address);
    const fail1 = qql.changeTokenRoyaltyRecipient(1, owner.address);
    await expect(fail1).to.be.revertedWith("QQL: unauthorized");
    const fail2 = qql
      .connect(passHolder)
      .changeTokenRoyaltyRecipient(1, ethers.constants.AddressZero);
    await expect(fail2).to.be.revertedWith("QQL: can't set zero address");
    await qql.connect(passHolder).changeTokenRoyaltyRecipient(1, owner.address);
    expect(await qql.tokenRoyaltyRecipient(1)).to.equal(owner.address);
  });

  it("project royalty recipient works", async () => {
    const { passHolder, qql, seed, signers } = await setup();
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
    const { passHolder, qql, seed, signers } = await setup();
    const owner = signers[0];
    await qql.setProjectRoyaltyRecipient(owner.address);

    const fail = qql.getRoyalties(1);
    await expect(fail).to.be.revertedWith("QQL: royalty for nonexistent token");

    await qql.connect(passHolder).mint(1, seed);
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
      seed,
      signers: [owner, nonOwner],
    } = await setup();
    await qql.connect(passHolder).mint(1, seed);
    const tokenId = 1;
    const nonTokenId = 9999;
    return { contract: qql, owner, nonOwner, tokenId, nonTokenId };
  });

  testOperatorFilter(async () => {
    const {
      qql,
      passHolder,
      seed,
      signers: [owner, nonOwner],
    } = await setup();
    await qql.connect(passHolder).mint(1, seed);
    const tokenId = 1;
    return {
      contract: qql,
      owner,
      nonOwner,
      tokenHolder: passHolder,
      tokenId,
    };
  });

  describe("extra operator filter tests", () => {
    it("allows minting when an operator filter is set for both QQL and MintPass", async () => {
      const [owner] = await ethers.getSigners();

      const BlacklistOperatorFilter = await ethers.getContractFactory(
        "BlacklistOperatorFilter"
      );
      const filter = await BlacklistOperatorFilter.deploy();

      const mp = await MintPass.deploy(9);
      await mp.deployed();
      const qql = await QQL.deploy(mp.address, 3, 0);
      await mp.setBurner(qql.address);

      await mp.reserve(owner.address, 1);
      const seed = generateSeed(owner.address, 1);

      await mp.setOperatorFilter(filter.address);
      await qql.setOperatorFilter(filter.address);

      expect(await mp.ownerOf(1)).to.equal(owner.address);
      await expect(qql.ownerOf(1)).to.be.revertedWith("ERC721:");

      await qql.mint(1, seed);

      await expect(mp.ownerOf(1)).to.be.revertedWith("ERC721:");
      expect(await qql.ownerOf(1)).to.equal(owner.address);
    });
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
