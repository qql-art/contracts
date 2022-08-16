const { expect } = require("chai");
const BN = ethers.BigNumber;

describe("QQL", () => {
  let MintPass;
  let QQL;
  let TestTokenUriDelegate;

  function generateHash(address, rest) {
    return ethers.utils.solidityPack(["address", "uint96"], [address, rest]);
  }

  before(async () => {
    MintPass = await ethers.getContractFactory("MintPass");
    QQL = await ethers.getContractFactory("QQL");
    TestTokenUriDelegate = await ethers.getContractFactory(
      "TestTokenUriDelegate"
    );
  });

  async function setup() {
    const mintPass = await MintPass.deploy(9);
    await mintPass.deployed();
    const qql = await QQL.deploy(mintPass.address);
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

  it("script pieces work", async () => {
    const mintPass = await MintPass.deploy(9);
    await mintPass.deployed();
    const qql = await QQL.deploy(mintPass.address);
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

  describe("tokenURI", () => {
    it("delegate can be set by the owner", async () => {
      const { qql } = await setup();
      const uriDelegate = await TestTokenUriDelegate.deploy();
      await qql.setTokenUriDelegate(uriDelegate.address);
      expect(await qql.tokenUriDelegate()).to.equal(uriDelegate.address);
    });
    it("delegate can't be set by non-owners", async () => {
      const [owner, notOwner] = await ethers.getSigners();
      const { qql } = await setup();
      const uriDelegate = await TestTokenUriDelegate.deploy();
      await expect(
        qql.connect(notOwner).setTokenUriDelegate(uriDelegate.address)
      ).to.be.revertedWith("Ownable:");
      expect(await qql.tokenUriDelegate()).to.equal(
        ethers.constants.AddressZero
      );
    });

    it("works when set or unset, with extant and non-existent tokens", async () => {
      const [owner] = await ethers.getSigners();
      const { qql, hash, passHolder } = await setup();
      await qql.connect(passHolder).mint(1, hash);

      expect(await qql.tokenURI(1)).to.equal("");
      await expect(qql.tokenURI(2)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );

      const uriDelegate = await TestTokenUriDelegate.deploy();
      await qql.setTokenUriDelegate(uriDelegate.address);

      expect(await qql.tokenURI(1)).to.equal(
        `data:text/plain,${qql.address.toLowerCase()}%20%231`
      );
      await expect(qql.tokenURI(2)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );
    });
  });
});
