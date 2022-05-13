const { expect } = require("chai");

describe("Ticket", () => {
  let Ticket;

  before(async () => {
    Ticket = await ethers.getContractFactory("Ticket");
  });

  it("total supply must be multiple of 3", async () => {
    const fail = Ticket.deploy(10);
    expect(fail).to.be.revertedWith("total supply must be multiple of 3");
  });

  describe("preminting", () => {
    it("preminting works", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const signers = await ethers.getSigners();
      await ticket.premint(3);
      expect(await ticket.balanceOf(signers[0].address)).to.equal(3);
    });
    it("preminting respects max supply", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      await ticket.premint(3);
      const fail = ticket.premint(9);
      expect(fail).to.be.revertedWith("too many mints");
    });
    it("premint must be batches of 3", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      const fail = ticket.premint(8);
      expect(fail).to.be.revertedWith("can only premint in batches of 3");
    });
    it("can't premint after auction start", async () => {
      const ticket = await Ticket.deploy(9);
      await ticket.deployed();
      await ticket.startAuction([1], 1);

      const fail = ticket.premint(3);
      expect(fail).to.be.revertedWith("auction started");
    });
  });

  describe("dutch auction", () => {
    async function increaseTime(secs) {
      await network.provider.send("evm_increaseTime", [secs]);
      await network.provider.send("evm_mine");
    }
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
      //
    });
  });
});
