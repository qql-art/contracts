const { expect } = require("chai");
const BN = ethers.BigNumber;

describe("TRNF", () => {
  let Ticket;
  let TRNF;

  before(async () => {
    Ticket = await ethers.getContractFactory("Ticket");
    TRNF = await ethers.getContractFactory("TRNF");
  });

  describe("minting", () => {
    it("a mint works as expected", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const trnf = await TRNF.deploy(ticket.address);
      await ticket.setBurner(trnf.address);
      const signers = await ethers.getSigners();
      const a = signers[1];
      await ticket.ownerMint(3, a.address);
      await trnf.connect(a).mint(0, "foo");
      expect(await trnf.balanceOf(a.address)).to.equal(1);
      const tokenData = await trnf.tokenData(0);
      expect(tokenData.minter).to.equal(a.address);
      expect(tokenData.data).to.equal("foo");
      expect(await trnf.ownerOf(0)).to.equal(a.address);
      expect(await ticket.balanceOf(a.address)).to.equal(2);
      // can't double-mint
      await expect(trnf.connect(a).mint(0, "bar")).to.be.revertedWith(
        "nonexistent token"
      );
    });
    it("only owner or approved can mint", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const trnf = await TRNF.deploy(ticket.address);
      await ticket.setBurner(trnf.address);
      const signers = await ethers.getSigners();
      const operator = signers[2];
      const a = signers[1];
      await ticket.ownerMint(3, a.address);
      const fail = trnf.connect(operator).mint(0, "foo");
      await expect(fail).to.be.revertedWith("owner or approved");
      await ticket.connect(a).approve(operator.address, 0);
      await trnf.connect(operator).mint(0, "foo");
      await ticket.connect(a).setApprovalForAll(operator.address, true);
      await trnf.connect(operator).mint(1, "foo");
      const tokenData0 = await trnf.tokenData(0);
      const tokenData1 = await trnf.tokenData(1);
      expect(tokenData0.minter).to.equal(operator.address);
      expect(tokenData1.minter).to.equal(operator.address);
      expect(await trnf.balanceOf(operator.address)).to.equal(2);
      expect(await ticket.balanceOf(a.address)).to.equal(1);
    });
  });
  it("token URIs work", async () => {
    const ticket = await Ticket.deploy(9);
    await ticket.deployed();
    const trnf = await TRNF.deploy(ticket.address);
    await ticket.setBurner(trnf.address);
    const signers = await ethers.getSigners();
    const a = signers[1];
    await ticket.ownerMint(3, a.address);
    await trnf.connect(a).mint(0, "foo");
    const fail = trnf.connect(a).setBaseURI("https://trnf.art/token/");
    await expect(fail).to.be.revertedWith("owner");
    await trnf.setBaseURI("https://trnf.art/token/");
    expect(await trnf.tokenURI(0)).to.equal("https://trnf.art/token/0");
    await trnf.setBaseURI("https://trnf2.art/token/");
    expect(await trnf.tokenURI(0)).to.equal("https://trnf2.art/token/0");
  });
  it("script pieces work", async () => {
    const ticket = await Ticket.deploy(9);
    await ticket.deployed();
    const trnf = await TRNF.deploy(ticket.address);
    const signers = await ethers.getSigners();
    const a = signers[1];
    await expect(trnf.connect(a).setScriptPiece(0, "hmm")).to.be.revertedWith(
      "owner"
    );
    await trnf.setScriptPiece(0, "hmm");
    await trnf.setScriptPiece(1, "ham");
    expect(await trnf.scriptPieces(0)).to.equal("hmm");
    expect(await trnf.scriptPieces(1)).to.equal("ham");
    await expect(trnf.setScriptPiece(0, "foo")).to.be.revertedWith("immutable");
  });
});
