const { expect } = require("chai");
const BN = ethers.BigNumber;

describe("Ticket", () => {
  let Ticket;

  before(async () => {
    Ticket = await ethers.getContractFactory("Ticket");
  });
  async function increaseTime(secs) {
    await network.provider.send("evm_increaseTime", [secs]);
    await network.provider.send("evm_mine");
  }

  it("total supply must be multiple of 3", async () => {
    const fail = Ticket.deploy(10);
    expect(fail).to.be.revertedWith("total supply must be multiple of 3");
  });

  describe("preminting", () => {
    it("preminting works", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const signers = await ethers.getSigners();
      await ticket.premint(3, signers[0].address);
      expect(await ticket.balanceOf(signers[0].address)).to.equal(3);
    });
    it("preminting respects max supply", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const signers = await ethers.getSigners();
      await ticket.premint(3, signers[0].address);
      const fail = ticket.premint(9, signers[0].address);
      expect(fail).to.be.revertedWith("too many mints");
    });
    it("premint must be batches of 3", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const signers = await ethers.getSigners();
      const fail = ticket.premint(8, signers[0].address);
      expect(fail).to.be.revertedWith("can only premint in batches of 3");
    });
    it("can't premint after auction start", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      await ticket.startAuction([1], 1);

      const signers = await ethers.getSigners();
      const fail = ticket.premint(3, signers[0].address);
      expect(fail).to.be.revertedWith("auction started");
    });
  });

  describe("dutch auction", () => {
    it("price is 0 before auction start, then decays per schedule", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      expect(await ticket.currentPrice()).to.equal(0);
      await ticket.startAuction([1000, 800, 400, 200], 10);
      expect(await ticket.currentPrice()).to.equal(1000);
      await increaseTime(5);
      expect(await ticket.currentPrice()).to.equal(1000);
      await increaseTime(5);
      expect(await ticket.currentPrice()).to.equal(800);
      await increaseTime(10);
      expect(await ticket.currentPrice()).to.equal(400);
      await increaseTime(10);
      expect(await ticket.currentPrice()).to.equal(200);
      await increaseTime(10);
      expect(await ticket.currentPrice()).to.equal(200);
    });
    it("tickets may be purchased at auction price", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      await ticket.startAuction([1000], 10);
      expect(await ticket.currentPrice()).to.equal(1000);
      const signers = await ethers.getSigners();
      const purchaser = signers[1];
      await ticket.connect(purchaser).mintAtAuction({ value: 1000 });
      expect(await ticket.provider.getBalance(ticket.address)).to.equal(1000);
      expect(await ticket.balanceOf(purchaser.address)).to.equal(3);
    });
    it("full ticket price must be paid", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      await ticket.startAuction([1000], 10);
      expect(await ticket.currentPrice()).to.equal(1000);
      const signers = await ethers.getSigners();
      const purchaser = signers[1];
      const fail0 = ticket.connect(purchaser).mintAtAuction();
      expect(fail0).to.be.revertedWith("must pay to mint");
      const fail1 = ticket.connect(purchaser).mintAtAuction({ value: 999 });
      expect(fail1).to.be.revertedWith("must pay to mint");
      // Overpaying is OK, though.
      await ticket.connect(purchaser).mintAtAuction({ value: 2000 });
      expect(await ticket.provider.getBalance(ticket.address)).to.equal(2000);
      expect(await ticket.balanceOf(purchaser.address)).to.equal(3);
    });
    it("wallet funds may be withdrawn by the Ticket deployer", async () => {
      const exa = BN.from("10").pow(18);
      const ticket = await Ticket.deploy(9);
      const provider = ticket.provider;

      await ticket.deployed();
      await ticket.startAuction([exa], 10);
      expect(await ticket.currentPrice()).to.equal(exa);
      const signers = await ethers.getSigners();
      const deployer = signers[0];
      const purchaser = signers[1];
      const fundRecipient = signers[2];
      const startingBalance = await fundRecipient.getBalance();
      await ticket.connect(purchaser).mintAtAuction({ value: exa });
      expect(await provider.getBalance(ticket.address)).to.equal(exa);
      const fail = ticket
        .connect(purchaser)
        .withdrawFunds(fundRecipient.address);
      expect(fail).to.be.revertedWith("owner");
      await ticket.withdrawFunds(fundRecipient.address);
      expect(await fundRecipient.getBalance()).to.equal(
        exa.add(startingBalance)
      );
      expect(await provider.getBalance(ticket.address)).to.equal(0);
    });
  });

  it("end-to-end example", async () => {
    const exa = BN.from("10").pow(18);
    const ticket = await Ticket.deploy(12);
    const provider = ticket.provider;
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const purchaser1 = signers[1];
    const purchaser2 = signers[2];
    const premint1 = signers[3];
    const premint2 = signers[4];
    const fundsRecipient = signers[5];

    await ticket.deployed();
    await ticket.premint(3, premint1.address);
    expect(await ticket.ownerOf(0)).to.equal(premint1.address);
    expect(await ticket.ownerOf(1)).to.equal(premint1.address);
    expect(await ticket.ownerOf(2)).to.equal(premint1.address);
    await ticket.premint(3, premint2.address);
    expect(await ticket.ownerOf(3)).to.equal(premint2.address);
    expect(await ticket.ownerOf(4)).to.equal(premint2.address);
    expect(await ticket.ownerOf(5)).to.equal(premint2.address);
    await ticket.startAuction([exa, exa.div(2)], 10);
    expect(await ticket.currentPrice()).to.equal(exa);
    await ticket.connect(purchaser1).mintAtAuction({ value: exa });
    expect(await ticket.ownerOf(6)).to.equal(purchaser1.address);
    expect(await ticket.ownerOf(7)).to.equal(purchaser1.address);
    expect(await ticket.ownerOf(8)).to.equal(purchaser1.address);
    await increaseTime(10);
    await ticket.connect(purchaser2).mintAtAuction({ value: exa.div(2) });
    expect(await ticket.ownerOf(9)).to.equal(purchaser2.address);
    expect(await ticket.ownerOf(10)).to.equal(purchaser2.address);
    expect(await ticket.ownerOf(11)).to.equal(purchaser2.address);
    const fail = ticket
      .connect(purchaser2)
      .mintAtAuction({ value: exa.div(2) });
    expect(fail).to.be.revertedWith("minted out");
    const startingBalance = await fundsRecipient.getBalance();
    await ticket.withdrawFunds(fundsRecipient.address);
    expect(await fundsRecipient.getBalance()).to.equal(
      startingBalance.add(exa.add(exa.div(2)))
    );
  });
});
