const { expect } = require("chai");
const BN = ethers.BigNumber;

describe("QQL", () => {
  let Ticket;
  let QQL;

  before(async () => {
    Ticket = await ethers.getContractFactory("Ticket");
    QQL = await ethers.getContractFactory("QQL");
  });

  describe("minting", () => {
    it("a mint works as expected", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const qql = await QQL.deploy(ticket.address);
      const signers = await ethers.getSigners();
      const a = signers[1];
      await ticket.ownerMint(3, a.address);
      const fail = qql.connect(a).mint(0, "foo");
      await expect(fail).to.be.revertedWith("only burner address");
      await ticket.setBurner(qql.address);
      await qql.connect(a).mint(0, "foo");
      expect(await qql.balanceOf(a.address)).to.equal(1);
      const tokenData = await qql.tokenData(0);
      expect(tokenData.minter).to.equal(a.address);
      expect(tokenData.data).to.equal("foo");
      expect(await qql.ownerOf(0)).to.equal(a.address);
      expect(await ticket.balanceOf(a.address)).to.equal(2);
      // can't double-mint
      await expect(qql.connect(a).mint(0, "bar")).to.be.revertedWith(
        "nonexistent token"
      );
    });
    it("only owner or approved can mint", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const qql = await QQL.deploy(ticket.address);
      await ticket.setBurner(qql.address);
      const signers = await ethers.getSigners();
      const operator = signers[2];
      const a = signers[1];
      await ticket.ownerMint(3, a.address);
      const fail = qql.connect(operator).mint(0, "foo");
      await expect(fail).to.be.revertedWith("owner or approved");
      await ticket.connect(a).approve(operator.address, 0);
      await qql.connect(operator).mint(0, "foo");
      await ticket.connect(a).setApprovalForAll(operator.address, true);
      await qql.connect(operator).mint(1, "foo");
      const tokenData0 = await qql.tokenData(0);
      const tokenData1 = await qql.tokenData(1);
      expect(tokenData0.minter).to.equal(operator.address);
      expect(tokenData1.minter).to.equal(operator.address);
      expect(await qql.balanceOf(operator.address)).to.equal(2);
      expect(await ticket.balanceOf(a.address)).to.equal(1);
    });
  });
  it("token URIs work", async () => {
    const ticket = await Ticket.deploy(9);
    await ticket.deployed();
    const qql = await QQL.deploy(ticket.address);
    await ticket.setBurner(qql.address);
    const signers = await ethers.getSigners();
    const a = signers[1];
    await ticket.ownerMint(3, a.address);
    await qql.connect(a).mint(0, "foo");
    const fail = qql.connect(a).setBaseURI("https://qql.art/token/");
    await expect(fail).to.be.revertedWith("owner");
    await qql.setBaseURI("https://qql.art/token/");
    expect(await qql.tokenURI(0)).to.equal("https://qql.art/token/0");
    await qql.setBaseURI("https://qql2.art/token/");
    expect(await qql.tokenURI(0)).to.equal("https://qql2.art/token/0");
  });
  it("script pieces work", async () => {
    const ticket = await Ticket.deploy(9);
    await ticket.deployed();
    const qql = await QQL.deploy(ticket.address);
    const signers = await ethers.getSigners();
    const a = signers[1];
    await expect(qql.connect(a).setScriptPiece(0, "hmm")).to.be.revertedWith(
      "owner"
    );
    await qql.setScriptPiece(0, "hmm");
    await qql.setScriptPiece(1, "ham");
    expect(await qql.scriptPieces(0)).to.equal("hmm");
    expect(await qql.scriptPieces(1)).to.equal("ham");
    await expect(qql.setScriptPiece(0, "foo")).to.be.revertedWith("immutable");
  });
});
